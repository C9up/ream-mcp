/**
 * Shared helpers for `security.*` check visitors (Story 33.7).
 *
 * `excerpt` extracts the source line at a given 1-indexed line
 * number, trims it, and elides at 120 characters with a trailing
 * `…`. The wire shape requires single-line excerpts only.
 */

import type { Node, SourceFile } from "ts-morph";

const MAX_EXCERPT = 120;

export function lineOf(node: Node): number {
	return node.getStartLineNumber();
}

export function excerpt(sf: SourceFile, line: number): string {
	const lines = sf.getFullText().split("\n");
	// Strip trailing CR first so CRLF / LF source produce identical
	// excerpts (and identical sha1 ids). Then trim, then expand
	// tabs — order matters: a tab-heavy line trimmed after expansion
	// would be padded to the cap before the elision kicks in.
	const raw = (lines[line - 1] ?? "")
		.replace(/\r$/, "")
		.trim()
		.replace(/\t/g, "    ");
	if (raw.length <= MAX_EXCERPT) return raw;
	return `${raw.slice(0, MAX_EXCERPT - 1)}…`;
}
