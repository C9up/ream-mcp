// GENERATED FROM THE RUST — do not edit.
//
// Produced by scripts/generate-napi-types.mjs from napi-derive's type-def
// output. Editing this file by hand puts it back where it started: a
// description that can disagree with the code it describes.

export declare function version(): string;

/**
 * Run an incremental (or full) corpus index. Returns the JSON-encoded
 * `IndexStats` (`{ files_seen, files_indexed, files_unchanged,
 * files_skipped, chunks_total, elapsed_ms }`).
 */

export declare function indexCorpus(root: string, full: boolean): string;

/**
 * Hybrid search. Returns JSON `SearchResult`. Pass an empty string for
 * `opts_json` to use defaults.
 */

export declare function search(
	root: string,
	query: string,
	optsJson: string,
): string;

/**
 * Look up a single chunk by stable id OR — when `by_topic` is true —
 * by heading topic (top-1 BM25 on `heading_path`).
 */

export declare function getChunk(
	root: string,
	idOrTopic: string,
	byTopic: boolean,
): string | null;

/** `@implements` lookup. Returns JSON `Vec<{ file, line }>`. */

export declare function trace(root: string, requirementId: string): string;

/** Drift audit. Returns JSON `Vec<{ file, stored_mtime, current_mtime }>`. */

export declare function auditDrift(root: string): string;
