//! NAPI thin wrapper around `ream-mcp-core`. Story 33.2 exposes
//! the indexer + search + trace + audit_drift surface.
//!
//! Keep this layer DUMB: no business logic, just `#[napi]`-wrapped
//! re-exports of `ream-mcp-core` functions. Mirrors the
//! ream-events / ream-events-napi separation.

#![deny(clippy::unwrap_used, clippy::expect_used)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use napi_derive::napi;
use once_cell::sync::Lazy;

use ream_mcp_core::indexer::{index, IndexConfig};
use ream_mcp_core::search::{search, SearchOptions, SearchResult};
use ream_mcp_core::store::{Store, StoredChunk};
use ream_mcp_core::trace::scan_dir;

/// Shared store cached by project-root path. Opening a SQLite DB +
/// bootstrapping the FTS5 schema is cheap, but we still want to
/// reuse one connection across NAPI calls so prepared statements
/// stay warm.
static STATE: Lazy<Mutex<Option<(PathBuf, Store)>>> = Lazy::new(|| Mutex::new(None));

fn db_path(root: &Path) -> PathBuf {
    root.join(".ream-mcp").join("index.sqlite")
}

fn with_store<R>(root: &str, f: impl FnOnce(&mut Store) -> R) -> Result<R, String> {
    let root_path = PathBuf::from(root);
    let mut guard = STATE.lock().map_err(|e| format!("state lock: {e}"))?;
    let needs_open = !matches!(guard.as_ref(), Some((p, _)) if p == &root_path);
    if needs_open {
        let store = Store::open(&db_path(&root_path)).map_err(|e| format!("store open: {e}"))?;
        *guard = Some((root_path.clone(), store));
    }
    let entry = guard
        .as_mut()
        .ok_or_else(|| "state mutated under us".to_string())?;
    Ok(f(&mut entry.1))
}

#[napi(js_name = "version")]
pub fn version() -> String {
    ream_mcp_core::version().to_string()
}

/// Run an incremental (or full) corpus index. Returns the JSON-encoded
/// `IndexStats` (`{ files_seen, files_indexed, files_unchanged,
/// files_skipped, chunks_total, elapsed_ms }`).
#[napi(js_name = "indexCorpus")]
pub fn index_corpus(root: String, full: bool) -> napi::Result<String> {
    let result = with_store(&root, |store| {
        index(
            store,
            &IndexConfig {
                root: PathBuf::from(&root),
                full_rebuild: full,
            },
        )
    })
    .map_err(napi::Error::from_reason)?;
    let stats = result.map_err(|e| napi::Error::from_reason(format!("index: {e}")))?;
    serde_json::to_string(&stats).map_err(|e| napi::Error::from_reason(format!("json: {e}")))
}

/// Hybrid search. Returns JSON `SearchResult`. Pass an empty string for
/// `opts_json` to use defaults.
#[napi(js_name = "search")]
pub fn search_napi(root: String, query: String, opts_json: String) -> napi::Result<String> {
    let opts: SearchOptions = if opts_json.trim().is_empty() {
        SearchOptions::default()
    } else {
        serde_json::from_str(&opts_json)
            .map_err(|e| napi::Error::from_reason(format!("opts parse: {e}")))?
    };
    let result: SearchResult = with_store(&root, |store| search(store, &query, &opts))
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&result).map_err(|e| napi::Error::from_reason(format!("json: {e}")))
}

/// Look up a single chunk by stable id OR — when `by_topic` is true —
/// by heading topic (top-1 BM25 on `heading_path`).
#[napi(js_name = "getChunk")]
pub fn get_chunk(
    root: String,
    id_or_topic: String,
    by_topic: bool,
) -> napi::Result<Option<String>> {
    let result = with_store(&root, |store| -> Result<Option<StoredChunk>, String> {
        if by_topic {
            store.top_by_topic(&id_or_topic).map_err(|e| e.to_string())
        } else {
            store.get_by_id(&id_or_topic).map_err(|e| e.to_string())
        }
    })
    .map_err(napi::Error::from_reason)?;
    let chunk_opt = result.map_err(napi::Error::from_reason)?;
    match chunk_opt {
        Some(c) => Ok(Some(
            serde_chunk_json(&c).map_err(|e| napi::Error::from_reason(e.to_string()))?,
        )),
        None => Ok(None),
    }
}

fn serde_chunk_json(c: &StoredChunk) -> Result<String, serde_json::Error> {
    let v = serde_json::json!({
        "id": c.id,
        "file": c.file,
        "heading_path": c.heading_path,
        "body": c.body,
        "kind": c.kind,
        "package": c.package,
        "line_start": c.line_start,
        "line_end": c.line_end,
    });
    serde_json::to_string(&v)
}

/// `@implements` lookup. Returns JSON `Vec<{ file, line }>`.
#[napi(js_name = "trace")]
pub fn trace_napi(root: String, requirement_id: String) -> napi::Result<String> {
    let idx = scan_dir(Path::new(&root));
    let sites = idx.lookup(&requirement_id);
    serde_json::to_string(&sites).map_err(|e| napi::Error::from_reason(format!("json: {e}")))
}

/// Drift audit. Returns JSON `Vec<{ file, stored_mtime, current_mtime }>`.
#[napi(js_name = "auditDrift")]
pub fn audit_drift_napi(root: String) -> napi::Result<String> {
    // Stat each tracked file on disk to compare against the stored mtime.
    let drift = with_store(&root, |store| -> Result<_, String> {
        let mut current: Vec<(String, i64)> = Vec::new();
        // Pull the tracked file list from the store, then stat each.
        // `audit_drift` works against the slice we hand it.
        let tracked = list_tracked_files(store).map_err(|e| e.to_string())?;
        for file in tracked {
            let abs = Path::new(&root).join(&file);
            let mtime = std::fs::metadata(&abs)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(-1);
            current.push((file, mtime));
        }
        store.audit_drift(&current).map_err(|e| e.to_string())
    })
    .map_err(napi::Error::from_reason)?;
    let drifted = drift.map_err(napi::Error::from_reason)?;
    let out: Vec<_> = drifted
        .into_iter()
        .map(|d| {
            serde_json::json!({
                "file": d.file,
                "stored_mtime": d.stored_mtime,
                "current_mtime": d.current_mtime,
            })
        })
        .collect();
    serde_json::to_string(&out).map_err(|e| napi::Error::from_reason(format!("json: {e}")))
}

fn list_tracked_files(store: &Store) -> Result<Vec<String>, ream_mcp_core::store::StoreError> {
    store.list_tracked_files()
}
