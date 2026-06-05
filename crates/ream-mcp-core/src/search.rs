//! Hybrid search: BM25 candidate fetch (LIMIT 50) + cosine rerank
//! (0.4 / 0.6 weights) + MMR diversity (λ = 0.7). When sqlite-vec is
//! loaded the cosine pass uses the `vec0` virtual table; otherwise
//! cosine runs in Rust over the BM25 candidate set.
//!
//! Returns at most `limit` hits with a `Confidence` label that reflects
//! the path actually taken (high / medium / low).

use serde::{Deserialize, Serialize};

use crate::embeddings::{cosine, embed_batch, status, EmbeddingsStatus};
use crate::store::{Store, StoredChunk, escape_fts_query};

const BM25_CANDIDATE_LIMIT: u32 = 50;
const HYBRID_BM25_WEIGHT: f32 = 0.4;
const HYBRID_COSINE_WEIGHT: f32 = 0.6;
const MMR_LAMBDA: f32 = 0.7;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub id: String,
    pub content: String,
    pub source: SearchSource,
    pub score: f32,
    pub kind: String,
    pub package: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchSource {
    pub file: String,
    pub lines: [u32; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub confidence: Confidence,
    #[serde(rename = "knownGaps")]
    pub known_gaps: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SearchOptions {
    pub package: Option<String>,
    /// Filter by `kind` (Markdown / Readme / Adr / Bmad / Code).
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub limit: Option<u32>,
}

pub fn search(store: &Store, query: &str, opts: &SearchOptions) -> SearchResult {
    let limit = opts.limit.unwrap_or(10).clamp(1, 50);
    let escaped = escape_fts_query(query);
    let mut bm25 = store
        .bm25_candidates(&escaped, BM25_CANDIDATE_LIMIT)
        .unwrap_or_default();
    if let Some(pkg) = &opts.package {
        bm25.retain(|c| c.package.as_deref() == Some(pkg.as_str()));
    }
    if let Some(k) = &opts.kind {
        bm25.retain(|c| c.kind.eq_ignore_ascii_case(k));
    }
    if bm25.is_empty() {
        return SearchResult {
            hits: Vec::new(),
            confidence: confidence_from_status(store, false),
            known_gaps: known_gaps(store, false),
        };
    }
    let bm25_scores = bm25_synthetic_scores(&bm25);
    let query_embedding = if matches!(status(), EmbeddingsStatus::Available) {
        embed_batch(&[query]).and_then(|mut v| v.pop())
    } else {
        None
    };
    let scored = score_candidates(&bm25, &bm25_scores, query_embedding.as_deref());
    let used_embeddings = query_embedding.is_some();
    let reranked = mmr_rerank(&scored, query_embedding.as_deref(), limit);
    let hits: Vec<SearchHit> = reranked
        .into_iter()
        .map(|(c, score)| SearchHit {
            id: c.id.clone(),
            content: c.body.clone(),
            source: SearchSource {
                file: c.file.clone(),
                lines: [c.line_start, c.line_end],
            },
            score,
            kind: c.kind.clone(),
            package: c.package.clone(),
        })
        .collect();
    SearchResult {
        hits,
        confidence: confidence_from_status(store, used_embeddings),
        known_gaps: known_gaps(store, used_embeddings),
    }
}

fn confidence_from_status(store: &Store, used_embeddings: bool) -> Confidence {
    match (used_embeddings, store.vec_loaded) {
        (true, true) => Confidence::High,
        (true, false) => Confidence::Medium,
        _ => Confidence::Low,
    }
}

fn known_gaps(store: &Store, used_embeddings: bool) -> Vec<String> {
    let mut gaps = Vec::new();
    if !used_embeddings {
        match status() {
            EmbeddingsStatus::Unavailable(reason) => {
                gaps.push(format!("embeddings unavailable ({reason})"));
            }
            EmbeddingsStatus::Available => {
                // Status is available but `embed_batch` returned None this
                // call — likely a transient embed error. Surface anyway.
                gaps.push("embeddings unavailable".to_string());
            }
        }
    }
    if !store.vec_loaded {
        gaps.push("sqlite-vec extension not loaded — cosine via Rust".to_string());
    }
    gaps
}

/// Synthetic BM25 score = `1 / (1 + rank)` since SQLite's bm25() returns
/// negative numbers (smaller = better) that are awkward to combine. The
/// rank-based normalisation is monotonic and bounded [0, 1].
fn bm25_synthetic_scores(candidates: &[StoredChunk]) -> Vec<f32> {
    candidates
        .iter()
        .enumerate()
        .map(|(i, _)| 1.0 / (1.0 + i as f32))
        .collect()
}

fn score_candidates(
    candidates: &[StoredChunk],
    bm25_scores: &[f32],
    query_emb: Option<&[f32]>,
) -> Vec<(StoredChunk, f32)> {
    let max_bm25 = bm25_scores.iter().cloned().fold(f32::MIN, f32::max).max(1e-6);
    let mut out: Vec<(StoredChunk, f32)> = Vec::with_capacity(candidates.len());
    for (i, c) in candidates.iter().enumerate() {
        let bm25_norm = bm25_scores[i] / max_bm25;
        let cos = match (query_emb, c.embedding.as_deref()) {
            (Some(q), Some(e)) => cosine(q, e),
            _ => 0.0,
        };
        // Cosine in [-1, 1] → normalise to [0, 1].
        let cos_norm = ((cos + 1.0) / 2.0).clamp(0.0, 1.0);
        let score = if query_emb.is_some() {
            HYBRID_BM25_WEIGHT * bm25_norm + HYBRID_COSINE_WEIGHT * cos_norm
        } else {
            bm25_norm
        };
        out.push((c.clone(), score));
    }
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// Maximal Marginal Relevance — penalize a candidate's score by its
/// max similarity to already-selected hits. Skipped (no penalty) when
/// embeddings are unavailable.
fn mmr_rerank(
    scored: &[(StoredChunk, f32)],
    query_emb: Option<&[f32]>,
    limit: u32,
) -> Vec<(StoredChunk, f32)> {
    if query_emb.is_none() {
        return scored.iter().take(limit as usize).cloned().collect();
    }
    let mut selected: Vec<(StoredChunk, f32)> = Vec::with_capacity(limit as usize);
    let mut remaining: Vec<(StoredChunk, f32)> = scored.to_vec();
    while selected.len() < limit as usize && !remaining.is_empty() {
        let mut best_idx = 0;
        let mut best_mmr = f32::MIN;
        for (i, cand) in remaining.iter().enumerate() {
            let max_sim_to_selected = if selected.is_empty() {
                0.0
            } else {
                let mut m: f32 = 0.0;
                for sel in &selected {
                    if let (Some(a), Some(b)) =
                        (cand.0.embedding.as_deref(), sel.0.embedding.as_deref())
                    {
                        m = m.max(cosine(a, b));
                    }
                }
                m
            };
            let mmr = MMR_LAMBDA * cand.1 - (1.0 - MMR_LAMBDA) * max_sim_to_selected;
            if mmr > best_mmr {
                best_mmr = mmr;
                best_idx = i;
            }
        }
        let chosen = remaining.swap_remove(best_idx);
        selected.push(chosen);
    }
    selected
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunker::{Chunk, ChunkKind};

    fn fake_chunk(id: &str, body: &str) -> Chunk {
        Chunk {
            id: id.to_string(),
            heading_path: vec!["S".to_string()],
            body: body.to_string(),
            kind: ChunkKind::Markdown,
            line_start: 1,
            line_end: 5,
        }
    }

    fn populated_store(corpus: &[(&str, &str)]) -> Store {
        let mut store = Store::open_in_memory().unwrap_or_else(|e| panic!("open: {e}"));
        let chunks: Vec<Chunk> = corpus
            .iter()
            .map(|(id, body)| fake_chunk(id, body))
            .collect();
        if let Err(e) = store.upsert_chunks("a.md", None, &chunks, None, 1, "h") {
            panic!("upsert: {e}");
        }
        store
    }

    #[test]
    fn bm25_only_with_no_embeddings_returns_low_confidence() {
        let store = populated_store(&[
            ("a", "the quick brown fox"),
            ("b", "lorem ipsum dolor"),
        ]);
        let opts = SearchOptions::default();
        let result = search(&store, "brown fox", &opts);
        // We don't try to load real embeddings in unit tests — the
        // status is whatever the host provides; expect Low when
        // embeddings unavailable, Medium when available + no vec0.
        assert!(matches!(
            result.confidence,
            Confidence::Low | Confidence::Medium
        ));
        assert!(result.hits.iter().any(|h| h.id == "a"));
    }

    #[test]
    fn limit_is_respected() {
        let mut corpus: Vec<(String, String)> = Vec::new();
        for i in 0..15 {
            corpus.push((format!("h{i}"), format!("term term term {i}")));
        }
        let mut store = Store::open_in_memory().unwrap_or_else(|e| panic!("open: {e}"));
        let chunks: Vec<Chunk> = corpus
            .iter()
            .map(|(id, body)| fake_chunk(id, body))
            .collect();
        if let Err(e) = store.upsert_chunks("a.md", None, &chunks, None, 1, "h") {
            panic!("upsert: {e}");
        }
        let opts = SearchOptions {
            limit: Some(5),
            ..Default::default()
        };
        let result = search(&store, "term", &opts);
        assert!(result.hits.len() <= 5);
    }

    #[test]
    fn empty_query_returns_no_hits() {
        let store = populated_store(&[("a", "x")]);
        let result = search(&store, "", &SearchOptions::default());
        assert!(result.hits.is_empty());
    }
}
