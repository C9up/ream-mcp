//! Corpus walker. Discovers markdown files under the project root,
//! chunks them, embeds (best-effort), and upserts into the store.
//!
//! Sources indexed (kind in parentheses):
//!   - `**/*.md` under `_bmad-output/planning-artifacts/` (Bmad)
//!   - `packages/*/README.md` (Readme)
//!   - `packages/*/CORRECTIONS.md` (Markdown)
//!   - `_bmad-output/planning-artifacts/adr-*.md` (Adr)
//!   - `docs/**/*.md` (Markdown)
//!
//! Skipped: `node_modules`, `dist`, `target`, `.git`, dot-dirs, any
//! file > 256 KB (a single bug-list dump can blow up the chunker).

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::chunker::{Chunk, ChunkKind, chunk_markdown};
use crate::embeddings::{Embedding, embed_batch};
use crate::store::{Store, StoreError};

const MAX_FILE_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IndexStats {
    pub files_seen: u32,
    pub files_indexed: u32,
    pub files_unchanged: u32,
    pub files_skipped: u32,
    pub chunks_total: u32,
    pub elapsed_ms: u64,
}

pub struct IndexConfig {
    pub root: PathBuf,
    pub full_rebuild: bool,
}

pub fn index(store: &mut Store, cfg: &IndexConfig) -> Result<IndexStats, StoreError> {
    let start = SystemTime::now();
    if cfg.full_rebuild {
        store.truncate_all()?;
    }
    let mut stats = IndexStats::default();
    let candidates = discover_files(&cfg.root);
    for (path, kind, package) in candidates {
        stats.files_seen += 1;
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => {
                stats.files_skipped += 1;
                continue;
            }
        };
        if meta.len() > MAX_FILE_BYTES {
            stats.files_skipped += 1;
            continue;
        }
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let rel = path
            .strip_prefix(&cfg.root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        if !cfg.full_rebuild {
            if let Ok(Some(stored)) = store.file_mtime(&rel) {
                if stored >= mtime_ms {
                    stats.files_unchanged += 1;
                    continue;
                }
            }
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => {
                stats.files_skipped += 1;
                continue;
            }
        };
        let content_hash = format!("{:x}", sha256_short(&bytes));
        let chunks: Vec<Chunk> = chunk_markdown(&bytes, kind.clone());
        if chunks.is_empty() {
            stats.files_skipped += 1;
            continue;
        }
        let embeddings = embed_chunks(&chunks);
        let pkg = package.as_deref();
        store.upsert_chunks(
            &rel,
            pkg,
            &chunks,
            embeddings.as_deref(),
            mtime_ms,
            &content_hash,
        )?;
        stats.files_indexed += 1;
        stats.chunks_total += chunks.len() as u32;
    }
    stats.elapsed_ms = SystemTime::now()
        .duration_since(start)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(stats)
}

fn embed_chunks(chunks: &[Chunk]) -> Option<Vec<Embedding>> {
    if chunks.is_empty() {
        return None;
    }
    let texts: Vec<&str> = chunks.iter().map(|c| c.body.as_str()).collect();
    embed_batch(&texts)
}

fn sha256_short(bytes: &[u8]) -> u64 {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut hash: u64 = 0;
    for (i, b) in digest.iter().take(8).enumerate() {
        hash |= (*b as u64) << (i * 8);
    }
    hash
}

fn discover_files(root: &Path) -> Vec<(PathBuf, ChunkKind, Option<String>)> {
    let mut out: Vec<(PathBuf, ChunkKind, Option<String>)> = Vec::new();
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
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if ext != "md" {
            continue;
        }
        let rel = path.strip_prefix(root).unwrap_or(path);
        let rel_str = rel.to_string_lossy().to_string();
        let (kind, package) = classify(&rel_str);
        out.push((path.to_path_buf(), kind, package));
    }
    out
}

fn classify(rel: &str) -> (ChunkKind, Option<String>) {
    if rel.starts_with("_bmad-output/planning-artifacts/adr-") {
        return (ChunkKind::Adr, None);
    }
    if rel.starts_with("_bmad-output/") {
        return (ChunkKind::Bmad, None);
    }
    if rel.ends_with("/README.md") || rel == "README.md" {
        let pkg = extract_package_name(rel);
        return (ChunkKind::Readme, pkg);
    }
    let pkg = extract_package_name(rel);
    (ChunkKind::Markdown, pkg)
}

fn extract_package_name(rel: &str) -> Option<String> {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.first() == Some(&"packages") && parts.len() >= 2 {
        return Some(parts[1].to_string());
    }
    None
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn classify_readmes_get_package_name() {
        let (k, p) = classify("packages/atlas/README.md");
        assert!(matches!(k, ChunkKind::Readme));
        assert_eq!(p.as_deref(), Some("atlas"));
    }

    #[test]
    fn classify_bmad_planning() {
        let (k, _) = classify("_bmad-output/planning-artifacts/epics.md");
        assert!(matches!(k, ChunkKind::Bmad));
    }

    #[test]
    fn classify_adr() {
        let (k, _) = classify("_bmad-output/planning-artifacts/adr-001-foo.md");
        assert!(matches!(k, ChunkKind::Adr));
    }

    #[test]
    fn classify_doc_outside_packages() {
        let (k, p) = classify("docs/en/intro.md");
        assert!(matches!(k, ChunkKind::Markdown));
        assert!(p.is_none());
    }

    #[test]
    fn full_rebuild_clears_then_reindexes() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        fs::create_dir_all(root.join("packages/foo")).expect("mkdir");
        fs::write(
            root.join("packages/foo/README.md"),
            "# Foo\n\n## Section\n\nbody.\n",
        )
        .expect("write");
        let mut store = Store::open_in_memory().unwrap_or_else(|e| panic!("open: {e}"));
        let cfg = IndexConfig {
            root: root.to_path_buf(),
            full_rebuild: true,
        };
        let stats = index(&mut store, &cfg).unwrap_or_else(|e| panic!("index: {e}"));
        assert_eq!(stats.files_indexed, 1);
        assert!(stats.chunks_total >= 1);
        assert_eq!(store.count_files().unwrap_or(0), 1);
    }

    #[test]
    fn incremental_skips_unchanged_files() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        fs::create_dir_all(root.join("packages/foo")).expect("mkdir");
        fs::write(root.join("packages/foo/README.md"), "# Foo\n\nbody.\n").expect("write");
        let mut store = Store::open_in_memory().unwrap_or_else(|e| panic!("open: {e}"));
        let cfg = IndexConfig {
            root: root.to_path_buf(),
            full_rebuild: false,
        };
        let s1 = index(&mut store, &cfg).unwrap_or_else(|e| panic!("first: {e}"));
        assert_eq!(s1.files_indexed, 1);
        let s2 = index(&mut store, &cfg).unwrap_or_else(|e| panic!("second: {e}"));
        assert_eq!(s2.files_indexed, 0);
        assert_eq!(s2.files_unchanged, 1);
    }
}
