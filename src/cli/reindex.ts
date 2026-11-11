#!/usr/bin/env node
/**
 * `ream-mcp reindex` — drives the Rust corpus indexer from the CLI.
 *
 *   ream-mcp reindex                   # incremental
 *   ream-mcp reindex --full            # drop + rebuild
 *   ream-mcp reindex --download-model  # fetch the embeddings model, then exit
 *
 * `--download-model` is the only path that fetches the embeddings model: it
 * says what it fetches and from where, checks every file against the SHA-256
 * pinned in the native core, and leaves nothing behind on a mismatch. The
 * server never downloads; with REAM_MCP_EMBEDDINGS=1 it loads these files.
 *
 * Output goes to stderr (preserves stdout for any future MCP pipe
 * use). Exits 0 on success, 1 on failure.
 */

import { core } from "../../index.js";
import { describeIndexStats, parseIndexStats } from "../util/index-stats.js";
import {
	describeDownload,
	downloadModel,
	parseModelManifest,
} from "../util/model-download.js";
import { detectProjectRoot } from "../util/project-root.js";

async function fetchModel(): Promise<number> {
	try {
		const manifest = parseModelManifest(core.embeddingModel());
		process.stderr.write(`[ream-mcp] ${describeDownload(manifest)}\n`);
		const { fetched, present } = await downloadModel(manifest, fetch, (line) =>
			process.stderr.write(`[ream-mcp]   ${line}\n`),
		);
		process.stderr.write(
			`[ream-mcp] model ready: ${fetched.length} fetched, ${present.length} already present. ` +
				"Set REAM_MCP_EMBEDDINGS=1 and ORT_DYLIB_PATH (absolute path to the ONNX Runtime library) to use it.\n",
		);
		return 0;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[ream-mcp] model download failed: ${msg}\n`);
		return 1;
	}
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	if (argv.includes("--download-model")) return fetchModel();
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
		const json = await core.indexCorpus(root, full);
		const stats = parseIndexStats(json);
		process.stderr.write(`[ream-mcp] done: ${describeIndexStats(stats)}\n`);
		return 0;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[ream-mcp] reindex failed: ${msg}\n`);
		return 1;
	}
}

process.exit(await main());
