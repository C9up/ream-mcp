//! `@implements` traceability scanner. Parses `@implements <ids>` from the
//! TypeScript sources of the project and builds an inverted index
//! `id -> Vec<{ file, line }>`.
//!
//! The walk is an allow-list, like the docs indexer's. Only the directories a
//! developer writes code in are read:
//!   - `packages/<name>/src/**` and `packages/<name>/tests/**` (a monorepo)
//!   - `app/`, `bin/`, `commands/`, `config/`, `database/`, `providers/`,
//!     `resources/`, `src/`, `start/`, `tests/` (an application)
//!
//! Everything else is never opened. An application keeps what its users send
//! under `storage/`, `public/`, `tmp/`...; walking the whole root let a user
//! who can drop a `.ts` there plant `@implements FR37`, which came back to the
//! coding agent as an implementation of that requirement.
//!
//! Inside the allowed roots: `node_modules`, `dist`, `target`, `coverage`,
//! dot-dirs and symlinks are skipped, a file over `MAX_FILE_BYTES` is not
//! read, and the walk stops after `MAX_FILES` files or `MAX_TOTAL_BYTES`
//! bytes, reporting `truncated` rather than a partial answer that looks whole.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

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
    /// The walk hit `MAX_FILES` or `MAX_TOTAL_BYTES` before the end.
    pub truncated: bool,
}

/// A source file larger than this is not read: no hand-written module is.
pub const MAX_FILE_BYTES: u64 = 256 * 1024;
/// Upper bound on the number of files one trace reads.
pub const MAX_FILES: usize = 20_000;
/// Upper bound on the bytes one trace reads.
pub const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

/// Application directories that hold the developer's own code.
const APP_ROOTS: &[&str] = &[
    "app",
    "bin",
    "commands",
    "config",
    "database",
    "providers",
    "resources",
    "src",
    "start",
    "tests",
];
/// Directories of a monorepo package that hold its code.
const PACKAGE_ROOTS: &[&str] = &["src", "tests"];

impl TraceIndex {
    pub fn lookup(&self, id: &str) -> Vec<ImplSite> {
        self.by_id.get(id).cloned().unwrap_or_default()
    }

    pub fn merge(&mut self, other: TraceIndex) {
        for (id, sites) in other.by_id {
            self.by_id.entry(id).or_default().extend(sites);
        }
        self.truncated |= other.truncated;
    }
}

/// The directories `scan_dir` walks, in a stable order.
fn source_roots(root: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = APP_ROOTS.iter().map(|d| root.join(d)).collect();
    if let Ok(entries) = std::fs::read_dir(root.join("packages")) {
        let mut pkgs: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect();
        pkgs.sort();
        for pkg in pkgs {
            for d in PACKAGE_ROOTS {
                out.push(pkg.join(d));
            }
        }
    }
    out
}

pub fn scan_dir(root: &Path) -> TraceIndex {
    scan_dir_bounded(root, MAX_FILES, MAX_TOTAL_BYTES)
}

fn scan_dir_bounded(root: &Path, max_files: usize, max_total_bytes: u64) -> TraceIndex {
    let mut idx = TraceIndex::default();
    let mut files = 0usize;
    let mut bytes_read = 0u64;
    for start in source_roots(root) {
        // `follow_root_links(false)`: an `app -> /` link must not be walked.
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
            if !is_typescript(path) {
                continue;
            }
            let len = match entry.metadata() {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            if len > MAX_FILE_BYTES {
                continue;
            }
            if files >= max_files || bytes_read.saturating_add(len) > max_total_bytes {
                idx.truncated = true;
                return idx;
            }
            files += 1;
            // Bounded read: a file that grew since `metadata` is still capped.
            let Some(bytes) = read_capped(path) else {
                continue;
            };
            bytes_read += bytes.len() as u64;
            let text = match std::str::from_utf8(&bytes) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let rel = path.strip_prefix(root).unwrap_or(path).to_path_buf();
            scan_text(&rel, text, &mut idx);
        }
    }
    idx
}

/// The file's bytes, or `None` when it cannot be read or exceeds
/// `MAX_FILE_BYTES`.
fn read_capped(path: &Path) -> Option<Vec<u8>> {
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return None;
    }
    Some(bytes)
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

    fn write(root: &Path, rel: &str, body: &[u8]) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().expect("parent")).expect("mkdir");
        std::fs::write(&p, body).expect("write");
    }

    fn files_for(idx: &TraceIndex, id: &str) -> Vec<String> {
        let mut files: Vec<String> = idx.lookup(id).into_iter().map(|s| s.file).collect();
        files.sort();
        files
    }

    #[test]
    fn only_the_source_roots_are_walked() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let marker = b"/** @implements FR7 */\nexport const x = 1;\n";
        for rel in [
            "packages/a/src/ok.ts",
            "packages/a/tests/ok.test.ts",
            "app/controllers/users.ts",
            "start/routes.ts",
            "tests/unit/x.test.ts",
            // What an application's users send, and anything else.
            "storage/uploads/user-42-avatar.ts",
            "public/files/note.tsx",
            "tmp/x.ts",
            "packages/a/storage/x.ts",
            "packages/a/node_modules/dep/index.ts",
            "app/.hidden/x.ts",
            "loose.ts",
        ] {
            write(root, rel, marker);
        }
        let idx = scan_dir(root);
        assert_eq!(
            files_for(&idx, "FR7"),
            vec![
                "app/controllers/users.ts",
                "packages/a/src/ok.ts",
                "packages/a/tests/ok.test.ts",
                "start/routes.ts",
                "tests/unit/x.test.ts",
            ]
        );
        assert!(!idx.truncated);
    }

    #[test]
    fn a_file_over_the_cap_is_not_read() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let mut big = b"// @implements FR7, MISS-1\n".to_vec();
        big.resize((MAX_FILE_BYTES + 1) as usize, b' ');
        write(root, "app/huge.ts", &big);
        write(root, "app/small.ts", b"// @implements FR7\n");
        let idx = scan_dir(root);
        assert_eq!(files_for(&idx, "FR7"), vec!["app/small.ts"]);
        assert!(idx.lookup("MISS-1").is_empty());
    }

    #[test]
    fn the_walk_stops_at_the_file_and_byte_budgets() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        for n in 0..5 {
            write(root, &format!("app/f{n}.ts"), b"// @implements FR7\n");
        }
        let all = scan_dir_bounded(root, 10, 1024);
        assert_eq!(all.lookup("FR7").len(), 5);
        assert!(!all.truncated);
        let by_files = scan_dir_bounded(root, 3, 1024);
        assert_eq!(by_files.lookup("FR7").len(), 3);
        assert!(by_files.truncated);
        // 19 bytes per file: two fit in 40, the third does not.
        let by_bytes = scan_dir_bounded(root, 10, 40);
        assert_eq!(by_bytes.lookup("FR7").len(), 2);
        assert!(by_bytes.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_source_root_is_not_followed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir().expect("tempdir");
        write(outside.path(), "x.ts", b"// @implements FR7\n");
        std::os::unix::fs::symlink(outside.path(), dir.path().join("app")).expect("link");
        let idx = scan_dir(dir.path());
        assert!(idx.lookup("FR7").is_empty());
    }

    #[test]
    fn path_normalises_backslashes() {
        let p = PathBuf::from("a/b\\c.ts");
        assert_eq!(path_string(&p), "a/b/c.ts");
    }
}
