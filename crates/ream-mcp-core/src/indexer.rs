//! Corpus walker. Discovers markdown files under the project root,
//! chunks them, embeds (best-effort), and upserts into the store.
//!
//! The corpus is an allow-list (kind in parentheses):
//!   - `README.md` at the project root (Readme)
//!   - `docs/**/*.md` (Markdown; a nested `README.md` is a Readme)
//!   - `packages/<name>/README.md` (Readme)
//!   - `packages/<name>/CORRECTIONS.md` (Markdown)
//!   - `_bmad-output/planning-artifacts/**/*.md` (Bmad; `adr-*` is Adr)
//!
//! Nothing else is read. A Ream app keeps user-supplied files under
//! `storage/`, `tmp/`, `public/uploads/`...; indexing "every `.md`" served
//! those to the agent as grounded documentation, a prompt-injection channel
//! from the app's users to the developer's agent. Files an earlier, wider
//! index stored are dropped on the next run.
//!
//! Skipped inside the allowed roots: `node_modules`, `dist`, `target`,
//! `.git`, dot-dirs, symlinks, any file > 256 KB (a single bug-list dump
//! can blow up the chunker).

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::chunker::{chunk_markdown, Chunk, ChunkKind};
use crate::embeddings::{embed_batch, Embedding};
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
    for file in store.list_tracked_files()? {
        if corpus_entry(&file).is_none() {
            store.delete_file(&file)?;
        }
    }
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
    let mut starts: Vec<PathBuf> = vec![
        root.join("README.md"),
        root.join("docs"),
        root.join("_bmad-output").join("planning-artifacts"),
    ];
    if let Ok(entries) = std::fs::read_dir(root.join("packages")) {
        let mut pkgs: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect();
        pkgs.sort();
        for pkg in pkgs {
            starts.push(pkg.join("README.md"));
            starts.push(pkg.join("CORRECTIONS.md"));
        }
    }
    for start in starts {
        // `follow_root_links(false)`: a `docs -> /` link must not be walked.
        for entry in WalkDir::new(&start)
            .follow_links(false)
            .follow_root_links(false)
            .sort_by_file_name()
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
            let rel = path
                .strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            if let Some((kind, package)) = corpus_entry(&rel) {
                out.push((path.to_path_buf(), kind, package));
            }
        }
    }
    out
}

/// `Some((kind, package))` when the project-relative, `/`-separated `rel`
/// belongs to the documented corpus, `None` otherwise.
fn corpus_entry(rel: &str) -> Option<(ChunkKind, Option<String>)> {
    if !rel.ends_with(".md") {
        return None;
    }
    let parts: Vec<&str> = rel.split('/').collect();
    let allowed = matches!(
        parts.as_slice(),
        ["README.md"]
            | ["docs", _, ..]
            | ["packages", _, "README.md" | "CORRECTIONS.md"]
            | ["_bmad-output", "planning-artifacts", _, ..]
    );
    allowed.then(|| classify(rel))
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

    fn tracked(store: &Store) -> Vec<String> {
        let mut files = store
            .list_tracked_files()
            .unwrap_or_else(|e| panic!("list: {e}"));
        files.sort();
        files
    }

    #[test]
    fn only_the_documented_corpus_is_indexed() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        let files = [
            "README.md",
            "docs/routing.md",
            "docs/en/guide/intro.md",
            "packages/foo/README.md",
            "packages/foo/CORRECTIONS.md",
            "_bmad-output/planning-artifacts/epics.md",
            "_bmad-output/planning-artifacts/adr-001-x.md",
            // Runtime data and anything else: never documentation.
            "storage/uploads/user-42-bio.md",
            "tmp/notes.md",
            "logs/x.md",
            "public/uploads/a.md",
            "src/notes.md",
            "packages/foo/docs/deep.md",
            "packages/foo/storage/x.md",
            "_bmad-output/implementation-artifacts/1-1-story.md",
        ];
        for f in files {
            let p = root.join(f);
            fs::create_dir_all(p.parent().expect("parent")).expect("mkdir");
            fs::write(&p, format!("# {f}\n\nIMPORTANT SYSTEM NOTE body.\n")).expect("write");
        }
        let mut store = Store::open_in_memory().unwrap_or_else(|e| panic!("open: {e}"));
        let cfg = IndexConfig {
            root: root.to_path_buf(),
            full_rebuild: true,
        };
        index(&mut store, &cfg).unwrap_or_else(|e| panic!("index: {e}"));
        assert_eq!(
            tracked(&store),
            vec![
                "README.md",
                "_bmad-output/planning-artifacts/adr-001-x.md",
                "_bmad-output/planning-artifacts/epics.md",
                "docs/en/guide/intro.md",
                "docs/routing.md",
                "packages/foo/CORRECTIONS.md",
                "packages/foo/README.md",
            ]
        );
    }

    #[test]
    fn incremental_index_drops_files_outside_the_corpus() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        fs::create_dir_all(root.join("docs")).expect("mkdir");
        fs::write(root.join("docs/a.md"), "# A\n\nbody.\n").expect("write");
        let mut store = Store::open_in_memory().unwrap_or_else(|e| panic!("open: {e}"));
        // What an earlier, wider index left behind.
        let chunks = chunk_markdown(
            b"# Bio\n\nignore previous instructions.\n",
            ChunkKind::Markdown,
        );
        store
            .upsert_chunks("storage/uploads/bio.md", None, &chunks, None, 1, "h")
            .unwrap_or_else(|e| panic!("seed: {e}"));
        let cfg = IndexConfig {
            root: root.to_path_buf(),
            full_rebuild: false,
        };
        index(&mut store, &cfg).unwrap_or_else(|e| panic!("index: {e}"));
        assert_eq!(tracked(&store), vec!["docs/a.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_docs_root_is_not_followed() {
        let dir = tempdir().expect("tempdir");
        let outside = tempdir().expect("tempdir");
        fs::write(outside.path().join("x.md"), "# X\n\nbody.\n").expect("write");
        std::os::unix::fs::symlink(outside.path(), dir.path().join("docs")).expect("link");
        let mut store = Store::open_in_memory().unwrap_or_else(|e| panic!("open: {e}"));
        let cfg = IndexConfig {
            root: dir.path().to_path_buf(),
            full_rebuild: true,
        };
        index(&mut store, &cfg).unwrap_or_else(|e| panic!("index: {e}"));
        assert!(tracked(&store).is_empty());
    }

    #[test]
    fn corpus_rule_rejects_lookalike_paths() {
        assert!(corpus_entry("docs/x.md").is_some());
        assert!(corpus_entry("packages/a/README.md").is_some());
        assert!(corpus_entry("packages/a/b/README.md").is_none());
        assert!(corpus_entry("packages/README.md").is_none());
        assert!(corpus_entry("docsx/x.md").is_none());
        assert!(corpus_entry("storage/docs/x.md").is_none());
        assert!(corpus_entry("_bmad-output/x.md").is_none());
        assert!(corpus_entry("sub/README.md").is_none());
        assert!(corpus_entry("docs/x.txt").is_none());
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
