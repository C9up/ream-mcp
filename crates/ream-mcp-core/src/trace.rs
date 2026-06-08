//! `@implements` traceability scanner. Walks `packages/**/*.ts`,
//! parses `@implements <ids>` from JSDoc blocks, builds an inverted
//! index `id -> Vec<{ file, line }>`.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImplSite {
    pub file: String,
    pub line: u32,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct TraceIndex {
    pub by_id: HashMap<String, Vec<ImplSite>>,
}

impl TraceIndex {
    pub fn lookup(&self, id: &str) -> Vec<ImplSite> {
        self.by_id.get(id).cloned().unwrap_or_default()
    }

    pub fn merge(&mut self, other: TraceIndex) {
        for (id, sites) in other.by_id {
            self.by_id.entry(id).or_default().extend(sites);
        }
    }
}

pub fn scan_dir(root: &Path) -> TraceIndex {
    let mut idx = TraceIndex::default();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !is_skipped(e.path()))
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if !is_typescript(path) {
            continue;
        }
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let text = match std::str::from_utf8(&bytes) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let rel = path.strip_prefix(root).unwrap_or(path).to_path_buf();
        scan_text(&rel, text, &mut idx);
    }
    idx
}

fn is_skipped(p: &Path) -> bool {
    let name = match p.file_name().and_then(|s| s.to_str()) {
        Some(n) => n,
        None => return false,
    };
    matches!(
        name,
        "node_modules" | "dist" | "target" | ".git" | ".pnpm-store" | "coverage"
    ) || (name.starts_with('.') && name != ".")
}

fn is_typescript(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|s| s.to_str()),
        Some("ts") | Some("tsx") | Some("mts") | Some("cts")
    )
}

pub fn scan_text(file: &Path, text: &str, out: &mut TraceIndex) {
    for (line_no, line) in text.lines().enumerate() {
        let line_idx = line_no as u32 + 1;
        let Some(rest) = extract_after_marker(line) else {
            continue;
        };
        for id in parse_ids(rest) {
            out.by_id.entry(id).or_default().push(ImplSite {
                file: path_to_string(file),
                line: line_idx,
            });
        }
    }
}

fn path_to_string(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn extract_after_marker(line: &str) -> Option<&str> {
    let trimmed = line.trim_start_matches([' ', '\t', '/', '*']);
    let needle = "@implements";
    let idx = trimmed.find(needle)?;
    let rest = &trimmed[idx + needle.len()..];
    // Strip trailing `*/` (JSDoc close) and any trailing whitespace.
    let cleaned = rest
        .trim()
        .trim_end_matches('/')
        .trim_end_matches('*')
        .trim_end();
    Some(cleaned)
}

fn parse_ids(rest: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in rest.split(',') {
        let token = raw.trim();
        if token.is_empty() {
            continue;
        }
        let token = token.split('(').next().unwrap_or(token).trim();
        if let Some(id) = match_fr(token) {
            out.push(id);
            continue;
        }
        if let Some(id) = match_miss(token) {
            out.push(id);
            continue;
        }
        if let Some(id) = match_story(token) {
            out.push(id);
            continue;
        }
        if let Some(id) = match_epic(token) {
            out.push(id);
            continue;
        }
        // Free-form tokens are NOT accepted — that would let prose like
        // "implements the spec" leak into the index. The 4 shapes above
        // are the project's documented traceability conventions; any
        // other label is silently dropped.
    }
    out
}

fn match_fr(token: &str) -> Option<String> {
    let bytes = token.as_bytes();
    if bytes.len() < 3 || !bytes.starts_with(b"FR") {
        return None;
    }
    let tail = &token[2..];
    if !tail.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(token.to_string())
}

fn match_miss(token: &str) -> Option<String> {
    let prefix = "MISS-";
    if !token.starts_with(prefix) {
        return None;
    }
    let tail = &token[prefix.len()..];
    if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(token.to_string())
}

fn match_story(token: &str) -> Option<String> {
    let prefix = "Story ";
    if !token.starts_with(prefix) {
        return None;
    }
    let tail = &token[prefix.len()..];
    let dot_split: Vec<&str> = tail.split('.').collect();
    if dot_split.len() < 2 || dot_split.len() > 3 {
        return None;
    }
    if !dot_split
        .iter()
        .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    Some(format!("Story {tail}"))
}

fn match_epic(token: &str) -> Option<String> {
    let prefix = "Epic ";
    if !token.starts_with(prefix) {
        return None;
    }
    let tail = &token[prefix.len()..];
    if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(format!("Epic {tail}"))
}

pub fn path_string(p: &Path) -> String {
    path_to_string(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn parses_single_fr() {
        let mut idx = TraceIndex::default();
        scan_text(
            &PathBuf::from("a.ts"),
            "/** @implements FR37 */\nexport class X {}\n",
            &mut idx,
        );
        let hits = idx.lookup("FR37");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 1);
    }

    #[test]
    fn parses_comma_list() {
        let mut idx = TraceIndex::default();
        scan_text(
            &PathBuf::from("a.ts"),
            "// @implements FR38, FR39, MISS-24, Story 32.7\n",
            &mut idx,
        );
        assert_eq!(idx.lookup("FR38").len(), 1);
        assert_eq!(idx.lookup("FR39").len(), 1);
        assert_eq!(idx.lookup("MISS-24").len(), 1);
        assert_eq!(idx.lookup("Story 32.7").len(), 1);
    }

    #[test]
    fn ignores_lines_without_marker() {
        let mut idx = TraceIndex::default();
        scan_text(
            &PathBuf::from("a.ts"),
            "// implements FR99 — note: no @ prefix, must NOT match\n",
            &mut idx,
        );
        assert!(idx.lookup("FR99").is_empty());
    }

    #[test]
    fn strips_parenthetical_comments() {
        let mut idx = TraceIndex::default();
        scan_text(
            &PathBuf::from("a.ts"),
            "/** @implements Story 29.8 (scope helper) */\n",
            &mut idx,
        );
        assert_eq!(idx.lookup("Story 29.8").len(), 1);
    }

    #[test]
    fn parses_epic() {
        let mut idx = TraceIndex::default();
        scan_text(
            &PathBuf::from("a.ts"),
            "/** @implements Epic 36 */\n",
            &mut idx,
        );
        assert_eq!(idx.lookup("Epic 36").len(), 1);
    }

    #[test]
    fn rejects_malformed_tokens() {
        let mut idx = TraceIndex::default();
        scan_text(
            &PathBuf::from("a.ts"),
            "/** @implements FRabc, MISS-, Story 32 */\n",
            &mut idx,
        );
        assert!(idx.lookup("FRabc").is_empty());
        assert!(idx.lookup("MISS-").is_empty());
        assert!(idx.lookup("Story 32").is_empty());
    }

    #[test]
    fn merges_indices() {
        let mut a = TraceIndex::default();
        a.by_id.insert(
            "FR1".to_string(),
            vec![ImplSite {
                file: "a.ts".into(),
                line: 1,
            }],
        );
        let mut b = TraceIndex::default();
        b.by_id.insert(
            "FR1".to_string(),
            vec![ImplSite {
                file: "b.ts".into(),
                line: 5,
            }],
        );
        a.merge(b);
        assert_eq!(a.lookup("FR1").len(), 2);
    }

    #[test]
    fn path_normalises_backslashes() {
        let p = PathBuf::from("a/b\\c.ts");
        assert_eq!(path_string(&p), "a/b/c.ts");
    }
}
