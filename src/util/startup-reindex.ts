/**
 * Startup incremental reindex. Audit 2026-05-22 F2: previously
 * awaited inside `bootstrap()` BEFORE `server.connect(transport)`,
 * which held the stdio transport closed for the full duration of the
 * corpus index. An MCP client `initialize` request landed on a dead
 * pipe and timed out — `tools/list` is index-independent but couldn't
 * even reach a handler. Now the reindex fires in the background; the
 * exported `indexReady` promise lets index-dependent tools
 * (`docs.search`, `docs.getChunk`, `docs.auditDrift`) await it on
 * demand, and the transport opens as soon as handlers are registered.
 *
 * Output goes to stderr (preserves stdout for JSON-RPC). If the
 * project root cannot be detected, we log a warning and `indexReady`
 * resolves immediately — the first tool call that needs the index
 * will surface the underlying error to the LLM.
 */

import { core } from "../../index.js";
import { detectProjectRoot } from "./project-root.js";

interface IndexStats {
	files_seen: number;
	files_indexed: number;
	files_unchanged: number;
	files_skipped: number;
	chunks_total: number;
	elapsed_ms: number;
}

/**
 * Resolves when the startup reindex finishes (or was skipped because
 * the project root could not be detected). Always resolves — failures
 * are reported via stderr but never propagated, so callers can
 * `await indexReady` without a try/catch and trust the binding to
 * make a best-effort attempt at a fresh index.
 *
 * Set by `startStartupReindex()`; callers MUST trigger that once at
 * bootstrap before relying on this promise.
 */
let indexReadyResolver: () => void = () => {};
export const indexReady: Promise<void> = new Promise<void>((resolve) => {
	indexReadyResolver = resolve;
});

let alreadyStarted = false;

/**
 * Kick off the reindex in the background. Returns immediately —
 * `await indexReady` to wait for completion. Idempotent: subsequent
 * calls are no-ops so a hot-reload bootstrap doesn't fire two indexes
 * concurrently.
 */
export function startStartupReindex(): void {
	if (alreadyStarted) return;
	alreadyStarted = true;
	void runStartupReindex().finally(() => indexReadyResolver());
}

/**
 * Direct entrypoint kept for backward compatibility and for tests
 * that want to drive the reindex synchronously. Production callers
 * should use `startStartupReindex()` + `await indexReady` instead.
 */
export async function runStartupReindex(): Promise<void> {
	let root: string;
	try {
		root = detectProjectRoot().path;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[ream-mcp] reindex skipped: ${msg}\n`);
		return;
	}
	try {
		const json = core.indexCorpus(root, false);
		const stats = JSON.parse(json) as IndexStats;
		process.stderr.write(
			`[ream-mcp] reindex: ${stats.files_indexed} indexed, ${stats.files_unchanged} unchanged, ${stats.files_skipped} skipped, ${stats.chunks_total} chunks total in ${stats.elapsed_ms}ms\n`,
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[ream-mcp] reindex failed: ${msg}\n`);
	}
}
