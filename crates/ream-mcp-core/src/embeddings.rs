//! fastembed-rs lazy-init wrapper. Resolves the cache dir from
//! `REAM_MCP_EMBED_CACHE_DIR` → `XDG_CACHE_HOME/ream-mcp/embeddings` →
//! `~/.cache/ream-mcp/embeddings`. If init fails (offline + cold cache),
//! `EmbeddingsStatus::Unavailable` is returned and the indexer/search
//! fall back to BM25-only with `confidence: "low"`.
//!
//! Initialisation happens on a BACKGROUND thread, and `status()` answers
//! immediately either way. It used to build the model inline, holding the
//! status mutex: on a cold cache that is hundreds of megabytes fetched with no
//! timeout and no progress, so the first search of a fresh install hung — and
//! every other caller hung behind the mutex with it. Answering "not yet" costs
//! that search its vectors and nothing else, because BM25 is already the
//! documented fallback and `confidence: "low"` already says so.
//!
//! `REAM_MCP_EMBED_WAIT` opts back into building it inline, for the case where
//! waiting is the right answer — indexing a repository once, deliberately.
//!
//! One consequence worth knowing before it costs someone an afternoon: a
//! warm-up in flight keeps the PROCESS alive until it finishes. `cargo test`
//! without `REAM_MCP_DISABLE_EMBEDDINGS` therefore prints its results, passes,
//! and then sits there for as long as the download takes — which reads as a
//! hang after a green run rather than before one. `pnpm test:rust` and CI both
//! set the variable; a bare `cargo test` does not.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;

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
/// Whether a background warm-up is in flight. One at a time: a failed attempt
/// clears it, so the next `status()` call starts another — the same
/// retry-on-next-call behaviour as before, just off the caller's thread.
static WARMING: AtomicBool = AtomicBool::new(false);

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
    {
        let guard = match STATUS.lock() {
            Ok(g) => g,
            Err(_) => return EmbeddingsStatus::Unavailable("status mutex poisoned".to_string()),
        };
        if let Some(EmbeddingsStatus::Available) = *guard {
            return EmbeddingsStatus::Available;
        }
    }

    // Opt-out for CI / offline: skip the fastembed model + ONNX-runtime download
    // (hundreds of MB, fetched lazily on first use) and fall back to BM25-only.
    //
    // `pnpm test:rust` sets it too. Without that, a cold cache turned the test
    // suite into a multi-minute download with no output — the run looked hung,
    // and the forty tests it was waiting to run take a hundredth of a second.
    if std::env::var("REAM_MCP_DISABLE_EMBEDDINGS").is_ok() {
        let s =
            EmbeddingsStatus::Unavailable("disabled via REAM_MCP_DISABLE_EMBEDDINGS".to_string());
        record(s.clone());
        return s;
    }

    // Opt-in to the old inline behaviour, for the caller that would rather wait
    // than index without vectors.
    if std::env::var("REAM_MCP_EMBED_WAIT").is_ok() {
        let s = init_model();
        record(s.clone());
        return s;
    }

    // Otherwise: answer now, build behind. `compare_exchange` rather than
    // `swap`, so a second caller arriving mid-warm-up does not start a second
    // download of the same model.
    if WARMING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        thread::spawn(|| {
            let s = init_model();
            record(s);
            WARMING.store(false, Ordering::Release);
        });
    }
    EmbeddingsStatus::Unavailable("model still initialising in the background".to_string())
}

/// Build the model. Runs WITHOUT the status lock held — on a cold cache this
/// is a multi-hundred-megabyte download, and holding the lock across it is
/// what made every other caller wait for it.
fn init_model() -> EmbeddingsStatus {
    init_model_in(cache_dir())
}

/// The body of {@link init_model}, taking its cache directory, so the failure
/// path can be exercised without env vars or a network fetch.
fn init_model_in(cache: PathBuf) -> EmbeddingsStatus {
    if let Err(err) = std::fs::create_dir_all(&cache) {
        return EmbeddingsStatus::Unavailable(format!("cache dir create failed: {err}"));
    }
    let opts = InitOptions::new(EmbeddingModel::BGESmallENV15).with_cache_dir(cache);
    match TextEmbedding::try_new(opts) {
        Ok(model) => {
            // First-time success installs the model; a later attempt (after a
            // previous Unavailable) hits `MODEL.set` as a no-op since the
            // OnceCell is already populated.
            let _ = MODEL.set(Mutex::new(Some(model)));
            EmbeddingsStatus::Available
        }
        Err(err) => EmbeddingsStatus::Unavailable(err.to_string()),
    }
}

/// Publish an outcome. A poisoned lock is not worth panicking over: the next
/// caller reads `None` and tries again.
fn record(s: EmbeddingsStatus) {
    if let Ok(mut guard) = STATUS.lock() {
        *guard = Some(s);
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

    #[test]
    fn a_cache_dir_that_cannot_be_created_reports_rather_than_panicking() {
        // A path under a regular file can never be a directory. This is the
        // one branch of init reachable without a network fetch, and it is the
        // branch that decides whether a broken cache degrades to BM25 or takes
        // the caller down.
        //
        // The background warm-up itself has no automated test: exercising it
        // needs a cold model cache and a real several-hundred-megabyte fetch,
        // and a test that skips itself whenever REAM_MCP_DISABLE_EMBEDDINGS is
        // set — which is how CI runs — would pass without checking anything.
        let mut file = std::env::temp_dir();
        file.push("ream-mcp-embeddings-not-a-dir");
        std::fs::write(&file, b"x").expect("write probe file");
        let status = init_model_in(file.join("under-a-file"));
        assert!(
            matches!(&status, EmbeddingsStatus::Unavailable(reason) if reason.contains("cache dir create failed")),
            "expected a cache-dir failure, got {status:?}"
        );
        let _ = std::fs::remove_file(&file);
    }
}
