// Hand-written types for the NAPI loader (`index.js`). All Rust core
// functions return either primitives or **JSON-encoded strings** —
// the TS layer is responsible for parsing. Keeping the FFI surface
// in primitives sidesteps NAPI codegen complexity for nested structs.

export interface ReamMcpCore {
	/** Rust crate version. Used as an FFI health check. */
	version(): string;
	/** Run an incremental (or full) corpus index. Returns
	 *  JSON-encoded `IndexStats`. */
	indexCorpus(root: string, full: boolean): string;
	/** Hybrid search. Returns JSON-encoded `SearchResult`. Pass an
	 *  empty string for `optsJson` to use defaults. */
	search(root: string, query: string, optsJson: string): string;
	/** Look up a chunk by id (or by topic when `byTopic` is true).
	 *  Returns JSON-encoded chunk, or `null` if not found. */
	getChunk(root: string, idOrTopic: string, byTopic: boolean): string | null;
	/** `@implements <id>` lookup. Returns JSON-encoded
	 *  `ImplSite[]`. */
	trace(root: string, requirementId: string): string;
	/** Drift audit. Returns JSON-encoded `DriftedFile[]`. */
	auditDrift(root: string): string;
}

export const core: ReamMcpCore;
