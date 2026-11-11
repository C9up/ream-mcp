/**
 * The corpus index's statistics, as the native `indexCorpus` returns them
 * (JSON), checked field by field.
 */

import { isRecord } from "./guards.js";

export interface IndexStats {
	files_seen: number;
	files_indexed: number;
	files_unchanged: number;
	files_skipped: number;
	files_failed: number;
	chunks_total: number;
	elapsed_ms: number;
}

const FIELDS = [
	"files_seen",
	"files_indexed",
	"files_unchanged",
	"files_skipped",
	"files_failed",
	"chunks_total",
	"elapsed_ms",
] as const;

export function parseIndexStats(json: string): IndexStats {
	const parsed: unknown = JSON.parse(json);
	if (!isRecord(parsed)) {
		throw new Error("unexpected index statistics from the native core");
	}
	const count = (field: (typeof FIELDS)[number]): number => {
		const value = parsed[field];
		if (typeof value !== "number" || !Number.isSafeInteger(value)) {
			throw new Error(`unexpected index statistics: ${field}`);
		}
		return value;
	};
	return {
		files_seen: count("files_seen"),
		files_indexed: count("files_indexed"),
		files_unchanged: count("files_unchanged"),
		files_skipped: count("files_skipped"),
		files_failed: count("files_failed"),
		chunks_total: count("chunks_total"),
		elapsed_ms: count("elapsed_ms"),
	};
}

/** One stderr line for a finished index. */
export function describeIndexStats(stats: IndexStats): string {
	return `${stats.files_indexed} indexed, ${stats.files_unchanged} unchanged, ${stats.files_skipped} skipped, ${stats.files_failed} failed, ${stats.chunks_total} chunks total in ${stats.elapsed_ms}ms`;
}
