//! fastembed-rs lazy-init wrapper. Resolves the cache dir from
//! `REAM_MCP_EMBED_CACHE_DIR` → `XDG_CACHE_HOME/ream-mcp/embeddings` →
//! `~/.cache/ream-mcp/embeddings`. If init fails (offline + cold cache),
//! `EmbeddingsStatus::Unavailable` is returned and the indexer/search
//! fall back to BM25-only with `confidence: "low"`.

use std::path::PathBuf;
use std::sync::Mutex;

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use once_cell::sync::OnceCell;

/// 384-dim cosine vector.
pub type Embedding = Vec<f32>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmbeddingsStatus {
    Available,
    Unavailable(String),
}

static MODEL: OnceCell<Mutex<Option<TextEmbedding>>> = OnceCell::new();
/// Cached status. `None` = never tried; `Some(Available)` = pinned (model
/// is loaded, model OnceCell already populated, no further retries);
/// `Some(Unavailable(_))` = retry on next call (lets a same-process
/// reindex recover after the model cache is hydrated).
static STATUS: Mutex<Option<EmbeddingsStatus>> = Mutex::new(None);

pub fn cache_dir() -> PathBuf {
    if let Ok(p) = std::env::var("REAM_MCP_EMBED_CACHE_DIR") {
        return PathBuf::from(p);
    }
    if let Ok(p) = std::env::var("XDG_CACHE_HOME") {
        return PathBuf::from(p).join("ream-mcp").join("embeddings");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home)
            .join(".cache")
            .join("ream-mcp")
            .join("embeddings");
    }
    std::env::temp_dir().join("ream-mcp-embeddings")
}

pub fn status() -> EmbeddingsStatus {
    let mut guard = match STATUS.lock() {
        Ok(g) => g,
        Err(_) => return EmbeddingsStatus::Unavailable("status mutex poisoned".to_string()),
    };
    if let Some(EmbeddingsStatus::Available) = *guard {
        return EmbeddingsStatus::Available;
    }
    let cache = cache_dir();
    if let Err(err) = std::fs::create_dir_all(&cache) {
        let s = EmbeddingsStatus::Unavailable(format!("cache dir create failed: {err}"));
        *guard = Some(s.clone());
        return s;
    }
    let opts = InitOptions::new(EmbeddingModel::BGESmallENV15).with_cache_dir(cache);
    match TextEmbedding::try_new(opts) {
        Ok(model) => {
            // First-time success installs the model; subsequent retries
            // (after a previous Unavailable) will hit `MODEL.set` as a
            // no-op since the OnceCell is already populated.
            let _ = MODEL.set(Mutex::new(Some(model)));
            *guard = Some(EmbeddingsStatus::Available);
            EmbeddingsStatus::Available
        }
        Err(err) => {
            let s = EmbeddingsStatus::Unavailable(err.to_string());
            *guard = Some(s.clone());
            s
        }
    }
}

/// Embed a batch of texts. Returns `None` if the model is unavailable —
/// callers treat `None` as "fall back to BM25-only" rather than throwing.
pub fn embed_batch(texts: &[&str]) -> Option<Vec<Embedding>> {
    if !matches!(status(), EmbeddingsStatus::Available) {
        return None;
    }
    let mutex = MODEL.get()?;
    let mut guard = mutex.lock().ok()?;
    let model = guard.as_mut()?;
    let owned: Vec<String> = texts.iter().map(|s| (*s).to_string()).collect();
    model.embed(owned, None).ok()
}

/// Encode a `Vec<f32>` as little-endian bytes for SQLite BLOB storage.
pub fn encode_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

/// Decode a SQLite BLOB back to `Vec<f32>`. Returns `None` on bad shape.
pub fn decode_blob(bytes: &[u8]) -> Option<Vec<f32>> {
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        let arr: [u8; 4] = match chunk.try_into() {
            Ok(a) => a,
            Err(_) => return None,
        };
        out.push(f32::from_le_bytes(arr));
    }
    Some(out)
}

/// Cosine similarity between two equal-dim vectors. Returns 0.0 on
/// length mismatch or zero norm rather than panicking.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0_f32;
    let mut na = 0.0_f32;
    let mut nb = 0.0_f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom == 0.0 {
        0.0
    } else {
        dot / denom
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_round_trip() {
        // Avoid 3.14 which clippy flags as approximate-PI; use
        // unrelated decimals that exercise the float bit pattern.
        let v = vec![0.0_f32, -1.5, 5.25, f32::INFINITY, -0.0];
        let bytes = encode_blob(&v);
        assert_eq!(bytes.len(), v.len() * 4);
        let back = decode_blob(&bytes).unwrap_or_default();
        assert_eq!(back.len(), v.len());
        for (a, b) in back.iter().zip(v.iter()) {
            // INFINITY round-trips bit-exact; -0.0 == 0.0 in PartialEq.
            if a.is_infinite() && b.is_infinite() {
                assert_eq!(a.is_sign_positive(), b.is_sign_positive());
            } else {
                assert!((a - b).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn decode_rejects_misaligned_bytes() {
        assert!(decode_blob(&[0, 0, 0]).is_none());
    }

    #[test]
    fn cosine_basic_cases() {
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
        assert!((cosine(&[1.0, 0.0], &[-1.0, 0.0]) + 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_handles_zero_and_mismatch() {
        assert_eq!(cosine(&[0.0, 0.0], &[1.0, 1.0]), 0.0);
        assert_eq!(cosine(&[1.0], &[1.0, 1.0]), 0.0);
        assert_eq!(cosine(&[], &[]), 0.0);
    }
}
