//! Embeddings for the docs index: BAAI bge-small-en-v1.5 through ONNX
//! Runtime. Off unless asked for, and never fetched from here.
//!
//! - **Opt-in.** `REAM_MCP_EMBEDDINGS=1` turns them on; without it every
//!   search is BM25-only with `confidence: "low"` (the documented fallback),
//!   and nothing is loaded. `REAM_MCP_DISABLE_EMBEDDINGS` wins over it.
//! - **No network.** This crate links no HTTP client. The model files are
//!   fetched once, on purpose, by `ream-mcp-reindex --download-model`, which
//!   says what it fetches and from where. The server only ever reads them
//!   from `model_dir()`.
//! - **Pinned.** `MODEL_FILES` pins the repository revision and the SHA-256
//!   and size of every file; the download command checks them, and so does
//!   every load here: a file that does not match is refused.
//! - **Explicit runtime.** ONNX Runtime is a shared library the user installs.
//!   `ORT_DYLIB_PATH` must name it by absolute path; the library search path
//!   is never consulted.
//!
//! The cache directory is `REAM_MCP_EMBED_CACHE_DIR`, else
//! `XDG_CACHE_HOME/ream-mcp/embeddings`, else `~/.cache/ream-mcp/embeddings`.
//!
//! Loading happens on a BACKGROUND thread and `status()` answers immediately
//! either way: reading and checking ~130 MB is not something a search should
//! wait on. `REAM_MCP_EMBED_WAIT` loads inline instead, for a deliberate
//! one-off index. A warm-up in flight keeps the process alive until it ends.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;

use fastembed::{
    InitOptionsUserDefined, Pooling, TextEmbedding, TokenizerFiles, UserDefinedEmbeddingModel,
};
use once_cell::sync::OnceCell;
use sha2::{Digest, Sha256};

/// The model, as the download command names it.
pub const MODEL_NAME: &str = "BAAI bge-small-en-v1.5 (ONNX)";
/// The repository the files come from.
pub const MODEL_REPO: &str = "Xenova/bge-small-en-v1.5";
/// The repository revision every URL is pinned to.
pub const MODEL_REVISION: &str = "ea104dacec62c0de699686887e3f920caeb4f3e3";

/// One file of the model, pinned by size and SHA-256.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelFile {
    /// Path inside the repository, and inside `model_dir()`.
    pub path: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}

pub const MODEL_FILES: &[ModelFile] = &[
    ModelFile {
        path: "config.json",
        sha256: "fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350",
        bytes: 683,
    },
    ModelFile {
        path: "special_tokens_map.json",
        sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
        bytes: 125,
    },
    ModelFile {
        path: "tokenizer_config.json",
        sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
        bytes: 366,
    },
    ModelFile {
        path: "tokenizer.json",
        sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
        bytes: 711_396,
    },
    ModelFile {
        path: "onnx/model.onnx",
        sha256: "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35",
        bytes: 133_093_490,
    },
];

/// The pinned download URL of `file`.
pub fn model_url(file: &ModelFile) -> String {
    format!(
        "https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/{}",
        file.path
    )
}

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

/// Where the pinned model files live.
pub fn model_dir() -> PathBuf {
    cache_dir().join("bge-small-en-v1.5").join(MODEL_REVISION)
}

/// Why embeddings stay off, or `None` when they were asked for.
fn opt_in(disabled: Option<OsString>, enabled: Option<OsString>) -> Option<String> {
    if disabled.is_some() {
        return Some("disabled via REAM_MCP_DISABLE_EMBEDDINGS".to_string());
    }
    if enabled.as_deref() != Some(std::ffi::OsStr::new("1")) {
        return Some(
            "off: set REAM_MCP_EMBEDDINGS=1 after `ream-mcp-reindex --download-model`".to_string(),
        );
    }
    None
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

    if let Some(reason) = opt_in(
        std::env::var_os("REAM_MCP_DISABLE_EMBEDDINGS"),
        std::env::var_os("REAM_MCP_EMBEDDINGS"),
    ) {
        let s = EmbeddingsStatus::Unavailable(reason);
        record(s.clone());
        return s;
    }

    // Load inline, for the caller that would rather wait than index without
    // vectors.
    if std::env::var("REAM_MCP_EMBED_WAIT").is_ok() {
        let s = init_model();
        record(s.clone());
        return s;
    }

    // Otherwise: answer now, load behind. `compare_exchange` rather than
    // `swap`, so a second caller arriving mid-warm-up does not start a second
    // load of the same model.
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
    EmbeddingsStatus::Unavailable("model still loading in the background".to_string())
}

fn init_model() -> EmbeddingsStatus {
    match load_model(&model_dir(), std::env::var_os("ORT_DYLIB_PATH")) {
        Ok(model) => {
            // A later attempt (after an earlier Unavailable) finds the
            // OnceCell populated and leaves it as it is.
            let _ = MODEL.set(Mutex::new(Some(model)));
            EmbeddingsStatus::Available
        }
        Err(reason) => EmbeddingsStatus::Unavailable(reason),
    }
}

/// The ONNX Runtime library `ORT_DYLIB_PATH` names: an absolute path to a
/// file. Anything else is refused rather than left to the loader's search
/// path, which is the environment's choice, not the user's.
fn ort_library(value: Option<OsString>) -> Result<PathBuf, String> {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return Err(
            "ORT_DYLIB_PATH is not set: name the ONNX Runtime library by absolute path".to_string(),
        );
    };
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("ORT_DYLIB_PATH must be an absolute path".to_string());
    }
    if !path.is_file() {
        return Err("ORT_DYLIB_PATH does not name a file".to_string());
    }
    Ok(path)
}

/// Read every file of `files` from `dir`, refusing any whose size or SHA-256
/// differs from its pin. Returned in the order of `files`.
fn read_verified(dir: &Path, files: &[ModelFile]) -> Result<Vec<Vec<u8>>, String> {
    let mut out = Vec::with_capacity(files.len());
    for file in files {
        let path = dir.join(file.path);
        let len = std::fs::metadata(&path).map(|m| m.len()).map_err(|_| {
            format!(
                "model file {} is missing: run `ream-mcp-reindex --download-model`",
                file.path
            )
        })?;
        if len != file.bytes {
            return Err(format!(
                "model file {} is {len} bytes, expected {}",
                file.path, file.bytes
            ));
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("model file {}: {e}", file.path))?;
        if sha256_hex(&bytes) != file.sha256 {
            return Err(format!(
                "model file {} does not match its pinned SHA-256",
                file.path
            ));
        }
        out.push(bytes);
    }
    Ok(out)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn load_model(dir: &Path, ort: Option<OsString>) -> Result<TextEmbedding, String> {
    let ort = ort_library(ort)?;
    let mut files = read_verified(dir, MODEL_FILES)?.into_iter();
    let mut next = || {
        files
            .next()
            .ok_or_else(|| "model manifest is shorter than expected".to_string())
    };
    // The order of MODEL_FILES.
    let config_file = next()?;
    let special_tokens_map_file = next()?;
    let tokenizer_config_file = next()?;
    let tokenizer_file = next()?;
    let onnx = next()?;
    // Once per process; a second call keeps the library already loaded.
    ort::init_from(&ort)
        .map_err(|e| format!("ONNX Runtime: {e}"))?
        .commit();
    let model = UserDefinedEmbeddingModel::new(
        onnx,
        TokenizerFiles {
            tokenizer_file,
            config_file,
            special_tokens_map_file,
            tokenizer_config_file,
        },
    )
    .with_pooling(Pooling::Cls);
    TextEmbedding::try_new_from_user_defined(model, InitOptionsUserDefined::new())
        .map_err(|e| e.to_string())
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
    // `.0` alone, and no `try_into`: the multiple-of-4 check above leaves no
    // remainder, and `as_chunks` already hands back a `[u8; 4]`.
    for chunk in bytes.as_chunks::<4>().0 {
        out.push(f32::from_le_bytes(*chunk));
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
    fn embeddings_are_off_unless_asked_for() {
        let off = opt_in(None, None).unwrap_or_default();
        assert!(off.contains("REAM_MCP_EMBEDDINGS=1"), "{off}");
        assert!(opt_in(None, Some("true".into())).is_some());
        assert!(opt_in(None, Some("0".into())).is_some());
        assert!(opt_in(None, Some("1".into())).is_none());
        assert!(opt_in(Some("1".into()), Some("1".into())).is_some());
    }

    #[test]
    fn the_onnx_runtime_must_be_named_by_absolute_path() {
        assert!(ort_library(None).is_err());
        assert!(ort_library(Some("".into())).is_err());
        assert!(ort_library(Some("libonnxruntime.so".into())).is_err());
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(ort_library(Some(dir.path().join("missing.so").into())).is_err());
        let lib = dir.path().join("libonnxruntime.so");
        std::fs::write(&lib, b"x").expect("write");
        assert_eq!(ort_library(Some(lib.clone().into())), Ok(lib));
    }

    const HELLO: ModelFile = ModelFile {
        path: "sub/hello.txt",
        // sha256("hello")
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        bytes: 5,
    };

    #[test]
    fn model_files_are_checked_against_their_pins() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = read_verified(dir.path(), &[HELLO])
            .err()
            .unwrap_or_default();
        assert!(missing.contains("--download-model"), "{missing}");

        std::fs::create_dir_all(dir.path().join("sub")).expect("mkdir");
        let path = dir.path().join(HELLO.path);
        std::fs::write(&path, b"hello").expect("write");
        assert_eq!(
            read_verified(dir.path(), &[HELLO]),
            Ok(vec![b"hello".to_vec()])
        );

        // Same size, different bytes: a tampered file.
        std::fs::write(&path, b"jello").expect("write");
        let tampered = read_verified(dir.path(), &[HELLO])
            .err()
            .unwrap_or_default();
        assert!(tampered.contains("SHA-256"), "{tampered}");

        std::fs::write(&path, b"hello!").expect("write");
        let resized = read_verified(dir.path(), &[HELLO])
            .err()
            .unwrap_or_default();
        assert!(resized.contains("expected 5"), "{resized}");
    }

    #[test]
    fn a_missing_model_is_refused_without_touching_the_network() {
        // The ONNX Runtime is checked first, then the files; neither path
        // fetches anything, and both name what the user must do.
        let dir = tempfile::tempdir().expect("tempdir");
        let lib = dir.path().join("libonnxruntime.so");
        std::fs::write(&lib, b"x").expect("write");
        let no_ort = load_model(dir.path(), None).err().unwrap_or_default();
        assert!(no_ort.contains("ORT_DYLIB_PATH"), "{no_ort}");
        let no_files = load_model(dir.path(), Some(lib.into()))
            .err()
            .unwrap_or_default();
        assert!(no_files.contains("--download-model"), "{no_files}");
    }

    #[test]
    fn every_pinned_file_has_a_pinned_url() {
        for file in MODEL_FILES {
            assert_eq!(file.sha256.len(), 64);
            assert!(file.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
            let url = model_url(file);
            assert!(url.starts_with("https://huggingface.co/"), "{url}");
            assert!(url.contains(MODEL_REVISION), "{url}");
        }
    }
}
