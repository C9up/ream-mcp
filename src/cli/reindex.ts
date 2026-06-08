#!/usr/bin/env node
/**
 * `ream-mcp reindex` — drives the Rust corpus indexer from the CLI.
 *
 *   ream-mcp reindex            # incremental
 *   ream-mcp reindex --full     # drop + rebuild
 *
 * Output goes to stderr (preserves stdout for any future MCP pipe
 * use). Exits 0 on success, 1 on failure.
 */

import { core } from "../../index.js";
import { detectProjectRoot } from "../util/project-root.js";

interface IndexStats {
	files_seen: number;
	files_indexed: number;
	files_unchanged: number;
	files_skipped: number;
	chunks_total: number;
	elapsed_ms: number;
}

function main(): number {
	const argv = process.argv.slice(2);
	const full = argv.includes("--full");
	let root: string;
	try {
		root = detectProjectRoot().path;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[ream-mcp] ${msg}\n`);
		return 1;
	}
	process.stderr.write(
		`[ream-mcp] reindex (${full ? "full" : "incremental"}) at ${root}\n`,
	);
	try {
		const json = core.indexCorpus(root, full);
		const stats = JSON.parse(json) as IndexStats;
		process.stderr.write(
			`[ream-mcp] done: ${stats.files_indexed} indexed, ${stats.files_unchanged} unchanged, ${stats.files_skipped} skipped, ${stats.chunks_total} chunks in ${stats.elapsed_ms}ms\n`,
		);
		return 0;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[ream-mcp] reindex failed: ${msg}\n`);
		return 1;
	}
}

process.exit(main());
