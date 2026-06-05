//! `ream-mcp-core` — pure Rust core for the Ream MCP server.
//!
//! Modules (Story 33.2):
//!   - `chunker`     — markdown AST walker → stable-id chunks.
//!   - `store`       — SQLite (FTS5 + BLOB) with optional sqlite-vec.
//!   - `embeddings`  — fastembed-rs lazy-init + offline fallback.
//!   - `search`      — BM25 + cosine + MMR rerank.
//!   - `trace`       — `@implements` scanner for traceability.
//!   - `indexer`     — corpus walker + per-file mtime cache.
//!
//! No NAPI imports here — the bindings layer (`ream-mcp-napi`) is the
//! only place that knows about JS. Mirrors the ream-events / ream-events-napi
//! split.

#![deny(clippy::unwrap_used, clippy::expect_used)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

pub mod chunker;
pub mod embeddings;
pub mod indexer;
pub mod search;
pub mod store;
pub mod trace;

/// Returns the crate version (set in `Cargo.toml`). Used as an FFI
/// health check so the TS server can fail fast at startup if the
/// `.node` binary is missing or incompatible.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_non_empty() {
        assert!(!version().is_empty(), "version must not be empty");
    }

    #[test]
    fn version_is_semver_shaped() {
        let parts: Vec<&str> = version().split('.').collect();
        assert!(
            parts.len() >= 3,
            "expected semver (e.g. 0.1.0), got '{}'",
            version()
        );
    }
}
