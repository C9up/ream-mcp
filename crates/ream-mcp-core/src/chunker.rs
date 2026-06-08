//! Markdown chunker. Walks `pulldown-cmark` events, slices the document
//! along H2/H3 boundaries, and emits stable-id chunks suitable for FTS5
//! + embedding storage.
//!
//! ## Cuts
//!
//! 1. **Heading-driven**: a new chunk starts at every H2 (and H3 inside
//!    its parent H2). Text before the first heading is emitted as a
//!    leading "(root)" chunk so README-style preambles don't get lost.
//! 2. **Hard-cut on overflow**: if a single section exceeds
//!    `MAX_CHUNK_CHARS` (~2048 chars ≈ 512 tokens at 4 chars/token), it
//!    splits at the next paragraph boundary with a `OVERLAP_CHARS`
//!    overlap into the next slice.
//!
//! ## Stable id
//!
//! `chunk_id(file_hash, heading_path)` = `{sha256(file_bytes)[..8]}:
//! {slug(heading_path)}`. Identical inputs always produce identical
//! ids → idempotent rebuilds.

use std::collections::HashMap;

use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};
use sha2::{Digest, Sha256};

/// Soft budget for one chunk in chars (≈ tokens × 4 for English).
pub const MAX_CHUNK_CHARS: usize = 2048;
/// Trailing overlap when a chunk hard-cuts mid-section.
pub const OVERLAP_CHARS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChunkKind {
    Markdown,
    Readme,
    Adr,
    Bmad,
    Code,
}

impl ChunkKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Markdown => "Markdown",
            Self::Readme => "Readme",
            Self::Adr => "Adr",
            Self::Bmad => "Bmad",
            Self::Code => "Code",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Chunk {
    pub id: String,
    pub heading_path: Vec<String>,
    pub body: String,
    pub kind: ChunkKind,
    /// 1-based line where this chunk starts in the source file.
    pub line_start: u32,
    /// 1-based line where this chunk ends.
    pub line_end: u32,
}

/// SHA-256 of `bytes`, hex-encoded, truncated to 8 chars.
pub fn file_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(8);
    for byte in digest.iter().take(4) {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

pub fn slugify_path(path: &[String]) -> String {
    if path.is_empty() {
        return "(root)".to_string();
    }
    path.iter()
        .map(|s| slug_segment(s))
        .collect::<Vec<_>>()
        .join(">")
}

fn slug_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_dash = false;
    for ch in s.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "x".to_string()
    } else {
        out
    }
}

pub fn chunk_id(file_hash_prefix: &str, heading_path: &[String]) -> String {
    format!("{}:{}", file_hash_prefix, slugify_path(heading_path))
}

pub fn chunk_markdown(file_bytes: &[u8], kind: ChunkKind) -> Vec<Chunk> {
    let text = match std::str::from_utf8(file_bytes) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let prefix = file_hash(file_bytes);

    let mut chunks: Vec<Chunk> = Vec::new();
    let mut heading_stack: Vec<(HeadingLevel, String)> = Vec::new();
    let mut current_path: Vec<String> = Vec::new();
    let mut current_body = String::new();
    let mut current_start_line: u32 = 1;
    let mut in_heading = false;
    let mut heading_buf = String::new();

    let parser = Parser::new(text);
    let line_offsets = build_line_offsets(text);

    for (event, range) in parser.into_offset_iter() {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                if matches!(level, HeadingLevel::H2 | HeadingLevel::H3) {
                    flush_chunk(
                        &mut chunks,
                        &prefix,
                        &current_path,
                        &mut current_body,
                        current_start_line,
                        offset_to_line(&line_offsets, range.start),
                        &kind,
                    );
                    current_start_line = offset_to_line(&line_offsets, range.start);
                }
                in_heading = true;
                heading_buf.clear();
            }
            Event::End(TagEnd::Heading(level)) => {
                in_heading = false;
                let title = heading_buf.trim().to_string();
                update_heading_stack(&mut heading_stack, level, title);
                current_path = heading_stack.iter().map(|(_, t)| t.clone()).collect();
            }
            Event::Text(text) => {
                if in_heading {
                    heading_buf.push_str(&text);
                } else {
                    current_body.push_str(&text);
                }
            }
            Event::Code(code) => {
                if in_heading {
                    heading_buf.push_str(&code);
                } else {
                    current_body.push('`');
                    current_body.push_str(&code);
                    current_body.push('`');
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if !in_heading {
                    current_body.push('\n');
                }
            }
            Event::End(TagEnd::Paragraph) => {
                if !in_heading {
                    current_body.push_str("\n\n");
                }
            }
            Event::End(TagEnd::CodeBlock) => {
                if !in_heading {
                    current_body.push_str("\n\n");
                }
            }
            _ => {}
        }
    }

    let last_line = (line_offsets.len() as u32).max(1);
    flush_chunk(
        &mut chunks,
        &prefix,
        &current_path,
        &mut current_body,
        current_start_line,
        last_line,
        &kind,
    );

    let mut split: Vec<Chunk> = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        if chunk.body.chars().count() <= MAX_CHUNK_CHARS {
            split.push(chunk);
            continue;
        }
        split.extend(hard_cut(chunk));
    }
    // Disambiguate ids when the same heading_path appears twice in a
    // file (and thus the chunk_id collides). Suffix `~2`, `~3`, …
    // — the `~` is distinct from hard-cut's `#N` so the two suffixes
    // can compose without clobbering each other.
    let mut seen: HashMap<String, u32> = HashMap::new();
    for chunk in &mut split {
        let n = seen.entry(chunk.id.clone()).or_insert(0);
        *n += 1;
        if *n > 1 {
            chunk.id = format!("{}~{}", chunk.id, *n);
        }
    }
    split
}

fn flush_chunk(
    out: &mut Vec<Chunk>,
    prefix: &str,
    path: &[String],
    body: &mut String,
    line_start: u32,
    line_end: u32,
    kind: &ChunkKind,
) {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        body.clear();
        return;
    }
    out.push(Chunk {
        id: chunk_id(prefix, path),
        heading_path: path.to_vec(),
        body: trimmed.to_string(),
        kind: kind.clone(),
        line_start,
        line_end: line_end.max(line_start),
    });
    body.clear();
}

fn hard_cut(chunk: Chunk) -> Vec<Chunk> {
    let mut out: Vec<Chunk> = Vec::new();
    let paragraphs: Vec<&str> = chunk.body.split("\n\n").collect();
    let mut buf = String::new();
    let mut idx = 0_u32;
    for para in paragraphs {
        if buf.chars().count() + para.chars().count() > MAX_CHUNK_CHARS && !buf.is_empty() {
            out.push(Chunk {
                id: format!("{}#{idx}", chunk.id),
                heading_path: append_split_marker(&chunk.heading_path, idx),
                body: buf.trim().to_string(),
                kind: chunk.kind.clone(),
                line_start: chunk.line_start,
                line_end: chunk.line_end,
            });
            idx += 1;
            buf = tail_overlap(&buf, OVERLAP_CHARS);
        }
        if !buf.is_empty() {
            buf.push_str("\n\n");
        }
        buf.push_str(para);
    }
    if !buf.trim().is_empty() {
        out.push(Chunk {
            id: format!("{}#{idx}", chunk.id),
            heading_path: append_split_marker(&chunk.heading_path, idx),
            body: buf.trim().to_string(),
            kind: chunk.kind.clone(),
            line_start: chunk.line_start,
            line_end: chunk.line_end,
        });
    }
    out
}

fn append_split_marker(path: &[String], idx: u32) -> Vec<String> {
    let mut out = path.to_vec();
    out.push(format!("part-{idx}"));
    out
}

fn tail_overlap(s: &str, n: usize) -> String {
    let count = s.chars().count();
    if count <= n {
        return s.to_string();
    }
    s.chars().skip(count - n).collect()
}

fn update_heading_stack(
    stack: &mut Vec<(HeadingLevel, String)>,
    level: HeadingLevel,
    title: String,
) {
    while let Some((top_level, _)) = stack.last() {
        if heading_rank(*top_level) >= heading_rank(level) {
            stack.pop();
        } else {
            break;
        }
    }
    stack.push((level, title));
}

fn heading_rank(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn build_line_offsets(text: &str) -> Vec<usize> {
    let mut offsets = vec![0usize];
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            offsets.push(i + 1);
        }
    }
    offsets
}

fn offset_to_line(offsets: &[usize], byte_offset: usize) -> u32 {
    match offsets.binary_search(&byte_offset) {
        Ok(idx) => (idx + 1) as u32,
        Err(idx) => idx.max(1) as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_h2_boundaries() {
        let md = "# Title\n\nIntro paragraph.\n\n## Section A\n\nBody A.\n\n## Section B\n\nBody B.\n";
        let chunks = chunk_markdown(md.as_bytes(), ChunkKind::Markdown);
        assert!(
            chunks.len() >= 3,
            "expected ≥ 3 chunks, got {}",
            chunks.len()
        );
        let bodies: Vec<&str> = chunks.iter().map(|c| c.body.as_str()).collect();
        assert!(bodies.iter().any(|b| b.contains("Intro paragraph")));
        assert!(bodies.iter().any(|b| b.contains("Body A")));
        assert!(bodies.iter().any(|b| b.contains("Body B")));
    }

    #[test]
    fn splits_on_h3_boundaries_inside_h2() {
        let md = "## Section A\n\n### Sub A1\n\nBody A1.\n\n### Sub A2\n\nBody A2.\n";
        let chunks = chunk_markdown(md.as_bytes(), ChunkKind::Markdown);
        let bodies: Vec<&str> = chunks.iter().map(|c| c.body.as_str()).collect();
        assert!(bodies.iter().any(|b| b.contains("Body A1")));
        assert!(bodies.iter().any(|b| b.contains("Body A2")));
    }

    #[test]
    fn ids_are_deterministic() {
        let md = "# T\n\n## S\n\nbody\n";
        let a = chunk_markdown(md.as_bytes(), ChunkKind::Markdown);
        let b = chunk_markdown(md.as_bytes(), ChunkKind::Markdown);
        let a_ids: Vec<&str> = a.iter().map(|c| c.id.as_str()).collect();
        let b_ids: Vec<&str> = b.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(a_ids, b_ids);
    }

    #[test]
    fn empty_heading_path_emits_root_id() {
        let md = "Just a body, no headings.\n";
        let chunks = chunk_markdown(md.as_bytes(), ChunkKind::Markdown);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].id.ends_with(":(root)"), "got {}", chunks[0].id);
    }

    #[test]
    fn h1_only_file_yields_single_chunk() {
        let md = "# Only Header\n\nThe body.\n";
        let chunks = chunk_markdown(md.as_bytes(), ChunkKind::Markdown);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].body.contains("The body"));
    }

    #[test]
    fn long_section_hard_cuts_with_overlap() {
        let para = "x".repeat(800);
        let md = format!("## S\n\n{para}\n\n{para}\n\n{para}\n");
        let chunks = chunk_markdown(md.as_bytes(), ChunkKind::Markdown);
        assert!(
            chunks.len() >= 2,
            "expected ≥ 2 hard-cut chunks, got {}",
            chunks.len()
        );
        for c in &chunks {
            assert!(
                c.body.chars().count() <= MAX_CHUNK_CHARS + 100,
                "chunk too big: {}",
                c.body.chars().count()
            );
        }
    }

    #[test]
    fn slug_handles_punctuation() {
        assert_eq!(slug_segment("Section A: Overview!"), "section-a-overview");
        assert_eq!(slug_segment("  spaces  "), "spaces");
        assert_eq!(slug_segment("---"), "x");
    }

    #[test]
    fn file_hash_is_8_hex_chars() {
        let h = file_hash(b"hello");
        assert_eq!(h.len(), 8);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn duplicate_headings_get_disambiguated_ids() {
        let md = "## Section\n\nfirst body\n\n## Section\n\nsecond body\n";
        let chunks = chunk_markdown(md.as_bytes(), ChunkKind::Markdown);
        let ids: Vec<&str> = chunks.iter().map(|c| c.id.as_str()).collect();
        let unique: std::collections::HashSet<&&str> = ids.iter().collect();
        assert_eq!(
            ids.len(),
            unique.len(),
            "duplicate ids in chunks: {ids:?}"
        );
        assert!(ids.iter().any(|i| i.contains("~2")), "expected ~2 suffix in {ids:?}");
    }
}
