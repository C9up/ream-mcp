//! SQLite persistence — FTS5 for BM25 + a plain `chunks` table with a
//! BLOB column for embeddings + a `files` table tracking per-file
//! mtime and content hash. `sqlite-vec` is loaded best-effort.

use std::path::Path;

use once_cell::sync::OnceCell;
use rusqlite::{Connection, OptionalExtension, params};
use thiserror::Error;

use crate::chunker::Chunk;
use crate::embeddings::{Embedding, decode_blob, encode_blob};

/// Tracks whether `sqlite3_auto_extension` was successfully called
/// once per process. Re-registering the same init pointer is harmless
/// in SQLite, but the FFI `transmute` is something we'd rather audit
/// once than on every `Store::open`.
static VEC_AUTOEXT_REGISTERED: OnceCell<bool> = OnceCell::new();

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

pub struct Store {
    conn: Connection,
    pub vec_loaded: bool,
}

#[derive(Debug, Clone)]
pub struct StoredChunk {
    pub id: String,
    pub file: String,
    pub heading_path: Vec<String>,
    pub body: String,
    pub kind: String,
    pub package: Option<String>,
    pub line_start: u32,
    pub line_end: u32,
    pub embedding: Option<Embedding>,
}

#[derive(Debug, Clone)]
pub struct DriftedFile {
    pub file: String,
    pub stored_mtime: i64,
    pub current_mtime: i64,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Register `sqlite3_vec_init` as an auto-extension exactly once
        // per process. The cast pattern mirrors the sqlite-vec crate's
        // own README example.
        // SAFETY: `sqlite3_auto_extension` modifies SQLite's global
        // extension list. The OnceCell guarantees we touch it from a
        // single initializer; subsequent `Store::open` calls see the
        // cached boolean. The transmute reinterprets a parameterless
        // FFI fn as the SQLite-extension signature — both are
        // `extern "C"`, layout-compatible at the C ABI level —
        // sqlite-vec exposes this form by design.
        let vec_attempted = *VEC_AUTOEXT_REGISTERED.get_or_init(|| unsafe {
            #[allow(clippy::missing_transmute_annotations)]
            let init_fn: unsafe extern "C" fn(
                *mut rusqlite::ffi::sqlite3,
                *mut *mut std::os::raw::c_char,
                *const rusqlite::ffi::sqlite3_api_routines,
            ) -> std::os::raw::c_int = std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            );
            let ret = rusqlite::ffi::sqlite3_auto_extension(Some(init_fn));
            ret == 0
        });
        let conn = Connection::open(path)?;
        let vec_loaded = if vec_attempted {
            conn.query_row("SELECT vec_version()", [], |row| row.get::<_, String>(0))
                .optional()
                .unwrap_or(None)
                .is_some()
        } else {
            false
        };

        bootstrap_schema(&conn)?;
        Ok(Self { conn, vec_loaded })
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        bootstrap_schema(&conn)?;
        Ok(Self {
            conn,
            vec_loaded: false,
        })
    }

    pub fn upsert_chunks(
        &mut self,
        file: &str,
        package: Option<&str>,
        chunks: &[Chunk],
        embeddings: Option<&[Embedding]>,
        mtime_ms: i64,
        content_hash: &str,
    ) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM chunks WHERE file = ?", params![file])?;
        for (idx, chunk) in chunks.iter().enumerate() {
            let blob = embeddings
                .and_then(|all| all.get(idx))
                .map(|v| encode_blob(v));
            let heading_joined = chunk.heading_path.join(">");
            tx.execute(
                "INSERT INTO chunks (id, file, line_start, line_end, heading_path, body, kind, package, embedding, source_mtime)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    chunk.id,
                    file,
                    chunk.line_start,
                    chunk.line_end,
                    heading_joined,
                    chunk.body,
                    chunk.kind.as_str(),
                    package,
                    blob,
                    mtime_ms,
                ],
            )?;
        }
        tx.execute(
            "INSERT INTO files (file, mtime, content_hash, indexed_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(file) DO UPDATE SET
               mtime = excluded.mtime,
               content_hash = excluded.content_hash,
               indexed_at = excluded.indexed_at",
            params![file, mtime_ms, content_hash, now_ms()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_file(&mut self, file: &str) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM chunks WHERE file = ?", params![file])?;
        tx.execute("DELETE FROM files WHERE file = ?", params![file])?;
        tx.commit()?;
        Ok(())
    }

    pub fn truncate_all(&mut self) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM chunks", [])?;
        tx.execute("DELETE FROM files", [])?;
        tx.commit()?;
        Ok(())
    }

    pub fn count_chunks(&self) -> Result<u32, StoreError> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get(0))?;
        Ok(n as u32)
    }

    pub fn count_files(&self) -> Result<u32, StoreError> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))?;
        Ok(n as u32)
    }

    pub fn audit_drift(
        &self,
        current: &[(String, i64)],
    ) -> Result<Vec<DriftedFile>, StoreError> {
        let mut out = Vec::new();
        let mut stmt = self.conn.prepare("SELECT file, mtime FROM files")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (file, stored_mtime) = row?;
            let cur = current
                .iter()
                .find(|(f, _)| f == &file)
                .map(|(_, m)| *m)
                .unwrap_or(-1);
            if cur > stored_mtime || cur == -1 {
                out.push(DriftedFile {
                    file,
                    stored_mtime,
                    current_mtime: cur,
                });
            }
        }
        Ok(out)
    }

    /// List every file currently tracked in the index. Used by the
    /// drift audit to know what to stat against the disk.
    pub fn list_tracked_files(&self) -> Result<Vec<String>, StoreError> {
        let mut stmt = self.conn.prepare("SELECT file FROM files ORDER BY file")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn file_mtime(&self, file: &str) -> Result<Option<i64>, StoreError> {
        let res = self
            .conn
            .query_row(
                "SELECT mtime FROM files WHERE file = ?",
                params![file],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        Ok(res)
    }

    pub fn bm25_candidates(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<StoredChunk>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT c.id, c.file, c.heading_path, c.body, c.kind, c.package, c.line_start, c.line_end, c.embedding
             FROM chunks_fts f
             JOIN chunks c ON c.rowid = f.rowid
             WHERE chunks_fts MATCH ?1
             ORDER BY bm25(chunks_fts) ASC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![query, limit as i64], stored_chunk_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn get_by_id(&self, id: &str) -> Result<Option<StoredChunk>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, file, heading_path, body, kind, package, line_start, line_end, embedding
             FROM chunks WHERE id = ?",
        )?;
        let res = stmt
            .query_row(params![id], stored_chunk_from_row)
            .optional()?;
        Ok(res)
    }

    pub fn top_by_topic(&self, topic: &str) -> Result<Option<StoredChunk>, StoreError> {
        // Escape FTS5-special chars in the user-provided topic so a
        // query like `foo OR bar` can't slip an operator past the
        // `heading_path:` column qualifier. Quoted tokens are literal.
        let escaped = escape_fts_query(topic);
        let mut stmt = self.conn.prepare(
            "SELECT c.id, c.file, c.heading_path, c.body, c.kind, c.package, c.line_start, c.line_end, c.embedding
             FROM chunks_fts f
             JOIN chunks c ON c.rowid = f.rowid
             WHERE chunks_fts MATCH 'heading_path:' || ?1
             ORDER BY bm25(chunks_fts) ASC
             LIMIT 1",
        )?;
        let res = stmt
            .query_row(params![escaped], stored_chunk_from_row)
            .optional()?;
        Ok(res)
    }
}

fn bootstrap_schema(conn: &Connection) -> Result<(), StoreError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chunks (
            id TEXT PRIMARY KEY,
            file TEXT NOT NULL,
            line_start INTEGER NOT NULL,
            line_end INTEGER NOT NULL,
            heading_path TEXT NOT NULL,
            body TEXT NOT NULL,
            kind TEXT NOT NULL,
            package TEXT,
            embedding BLOB,
            source_mtime INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file);
         CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            heading_path, body,
            content='chunks',
            content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
         );
         CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts(rowid, heading_path, body)
            VALUES (new.rowid, new.heading_path, new.body);
         END;
         CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, heading_path, body)
            VALUES ('delete', old.rowid, old.heading_path, old.body);
         END;
         CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, heading_path, body)
            VALUES ('delete', old.rowid, old.heading_path, old.body);
            INSERT INTO chunks_fts(rowid, heading_path, body)
            VALUES (new.rowid, new.heading_path, new.body);
         END;
         CREATE TABLE IF NOT EXISTS files (
            file TEXT PRIMARY KEY,
            mtime INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            indexed_at INTEGER NOT NULL
         );",
    )?;
    Ok(())
}

fn stored_chunk_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredChunk> {
    let heading_joined: String = row.get(2)?;
    let heading_path = if heading_joined.is_empty() {
        Vec::new()
    } else {
        heading_joined.split('>').map(|s| s.to_string()).collect()
    };
    let blob: Option<Vec<u8>> = row.get(8)?;
    let embedding = blob.and_then(|b| decode_blob(&b));
    Ok(StoredChunk {
        id: row.get(0)?,
        file: row.get(1)?,
        heading_path,
        body: row.get(3)?,
        kind: row.get(4)?,
        package: row.get(5)?,
        line_start: row.get::<_, i64>(6)? as u32,
        line_end: row.get::<_, i64>(7)? as u32,
        embedding,
    })
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Escape FTS5-special chars so a free-form user query doesn't break
/// the parser. Quote each token; AND-join.
pub fn escape_fts_query(query: &str) -> String {
    let tokens: Vec<String> = query
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| {
            let cleaned: String = t
                .chars()
                .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '/'))
                .collect();
            if cleaned.is_empty() {
                String::new()
            } else {
                format!("\"{cleaned}\"")
            }
        })
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        "\"__never_matches__\"".to_string()
    } else {
        tokens.join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunker::{Chunk, ChunkKind};

    fn fake_chunk(id: &str, body: &str) -> Chunk {
        Chunk {
            id: id.to_string(),
            heading_path: vec!["Top".to_string(), "Sub".to_string()],
            body: body.to_string(),
            kind: ChunkKind::Markdown,
            line_start: 1,
            line_end: 10,
        }
    }

    #[test]
    fn bootstrap_in_memory() {
        let store = match Store::open_in_memory() {
            Ok(s) => s,
            Err(e) => panic!("open: {e}"),
        };
        assert!(!store.vec_loaded);
        assert_eq!(store.count_chunks().unwrap_or(99), 0);
    }

    #[test]
    fn upsert_round_trip() {
        let mut store = match Store::open_in_memory() {
            Ok(s) => s,
            Err(e) => panic!("open: {e}"),
        };
        let chunks = vec![
            fake_chunk("h1:a", "alpha body"),
            fake_chunk("h1:b", "beta body"),
        ];
        if let Err(e) = store.upsert_chunks("docs/file.md", Some("ream"), &chunks, None, 1000, "abc") {
            panic!("upsert: {e}");
        }
        assert_eq!(store.count_chunks().unwrap_or(0), 2);
        assert_eq!(store.count_files().unwrap_or(0), 1);

        let got = match store.get_by_id("h1:a") {
            Ok(g) => g,
            Err(e) => panic!("get: {e}"),
        };
        let chunk = match got {
            Some(c) => c,
            None => panic!("missing"),
        };
        assert_eq!(chunk.body, "alpha body");
    }

    #[test]
    fn upsert_replaces_prior_chunks_for_file() {
        let mut store = match Store::open_in_memory() {
            Ok(s) => s,
            Err(e) => panic!("open: {e}"),
        };
        let v1 = vec![fake_chunk("v1:a", "old")];
        if let Err(e) = store.upsert_chunks("f.md", None, &v1, None, 1, "old") {
            panic!("v1: {e}");
        }
        let v2 = vec![fake_chunk("v2:a", "new")];
        if let Err(e) = store.upsert_chunks("f.md", None, &v2, None, 2, "new") {
            panic!("v2: {e}");
        }
        assert_eq!(store.count_chunks().unwrap_or(99), 1);
        let stale = store.get_by_id("v1:a").unwrap_or(None);
        assert!(stale.is_none());
        let fresh = store.get_by_id("v2:a").unwrap_or(None);
        assert!(fresh.is_some());
    }

    #[test]
    fn bm25_finds_query_terms() {
        let mut store = match Store::open_in_memory() {
            Ok(s) => s,
            Err(e) => panic!("open: {e}"),
        };
        let chunks = vec![
            fake_chunk("h:1", "the quick brown fox jumps over the lazy dog"),
            fake_chunk("h:2", "an unrelated paragraph about widgets"),
        ];
        if let Err(e) = store.upsert_chunks("a.md", None, &chunks, None, 1, "h") {
            panic!("upsert: {e}");
        }
        let q = escape_fts_query("brown fox");
        let hits = store.bm25_candidates(&q, 10).unwrap_or_default();
        assert!(hits.iter().any(|c| c.id == "h:1"));
    }

    #[test]
    fn drift_detects_newer_disk_mtime() {
        let mut store = match Store::open_in_memory() {
            Ok(s) => s,
            Err(e) => panic!("open: {e}"),
        };
        if let Err(e) = store.upsert_chunks(
            "a.md",
            None,
            &[fake_chunk("h:1", "x")],
            None,
            1000,
            "h",
        ) {
            panic!("upsert: {e}");
        }
        let drift = store
            .audit_drift(&[("a.md".to_string(), 2000)])
            .unwrap_or_default();
        assert_eq!(drift.len(), 1);
        assert_eq!(drift[0].file, "a.md");
        assert_eq!(drift[0].current_mtime, 2000);
    }

    #[test]
    fn drift_flags_deleted_files_with_sentinel() {
        let mut store = match Store::open_in_memory() {
            Ok(s) => s,
            Err(e) => panic!("open: {e}"),
        };
        if let Err(e) = store.upsert_chunks("gone.md", None, &[fake_chunk("h:1", "x")], None, 1, "h") {
            panic!("upsert: {e}");
        }
        let drift = store.audit_drift(&[]).unwrap_or_default();
        assert_eq!(drift.len(), 1);
        assert_eq!(drift[0].current_mtime, -1);
    }

    #[test]
    fn fts_query_escape_strips_special_chars() {
        let q = escape_fts_query("foo*bar (query)");
        assert!(!q.contains('*'));
        assert!(!q.contains('('));
        assert!(q.contains("foobar"));
    }

    #[test]
    fn fts_query_empty_returns_never_match() {
        assert_eq!(escape_fts_query(""), "\"__never_matches__\"");
        assert_eq!(escape_fts_query("()*"), "\"__never_matches__\"");
    }
}
