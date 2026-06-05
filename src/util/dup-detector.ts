/**
 * Token-stream duplicate detector.
 *
 * Story 33.5 — `quality.duplicates` MCP tool. Walks each TS source
 * file (skipping `.d.ts` and `node_modules` via `eachSourceFile`),
 * builds a normalized token stream (identifiers anonymized,
 * literals + keywords + punctuation preserved), and reports any
 * fragment of ≥ `minTokens` tokens that appears in two or more
 * places. Matched runs are extended greedily so the reported
 * `tokens` field reflects the actual clone size, not just
 * `minTokens`.
 *
 * Determinism: the output is sorted by `tokens` desc, then by the
 * lexicographic order of the first occurrence's path.
 *
 * Scope cuts (per the story's Dev Notes):
 *   - Exact-token match only — `similarity` is reserved at 1.0.
 *   - Files > 1 MB or with parse errors are skipped (recorded in
 *     the `skipped` list).
 *   - Identifiers are anonymized; literals (string, number,
 *     regex, template parts) are preserved — different SQL/JSON
 *     strings won't match.
 */

import { relative } from "node:path";
import type { Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { eachSourceFile } from "./ts-static-parser.js";

const MAX_FILE_BYTES = 1_048_576; // 1 MB
const MAX_MIN_TOKENS = 5_000;
const MAX_MIN_LINES = 5_000;

export interface DupOptions {
	minTokens: number;
	minLines: number;
}

export interface DupOccurrence {
	path: string;
	lines: [number, number];
}

export interface Duplicate {
	files: DupOccurrence[];
	tokens: number;
	similarity: number;
}

export interface DupResult {
	duplicates: Duplicate[];
	skipped: string[];
}

interface NormalizedToken {
	normalized: string;
	line: number;
}

interface WindowKey {
	path: string;
	startIdx: number;
}

interface ExtendedWindow {
	path: string;
	startIdx: number;
	length: number;
	startLine: number;
	endLine: number;
}

export function findDuplicates(
	project: Project,
	root: string,
	opts: DupOptions,
): DupResult {
	if (opts.minTokens < 1) throw new Error("minTokens must be >= 1");
	if (opts.minTokens > MAX_MIN_TOKENS)
		throw new Error(`minTokens must be <= ${MAX_MIN_TOKENS}`);
	if (opts.minLines < 1) throw new Error("minLines must be >= 1");
	if (opts.minLines > MAX_MIN_LINES)
		throw new Error(`minLines must be <= ${MAX_MIN_LINES}`);

	const skipped: string[] = [];
	const fileTokens = new Map<string, NormalizedToken[]>();
	const buckets = new Map<number, WindowKey[]>();

	eachSourceFile(project, (sf) => {
		const filePath = sf.getFilePath();
		const relPath = toForwardSlash(relative(root, filePath));

		if (sf.getFullText().length > MAX_FILE_BYTES) {
			skipped.push(`${relPath} (> 1 MB)`);
			return;
		}
		let tokens: NormalizedToken[];
		try {
			tokens = tokenize(sf);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			skipped.push(`${relPath} (parse error: ${detail})`);
			return;
		}

		if (tokens.length < opts.minTokens) return;
		fileTokens.set(relPath, tokens);

		for (let i = 0; i + opts.minTokens <= tokens.length; i++) {
			const startLine = tokens[i].line;
			const endLine = tokens[i + opts.minTokens - 1].line;
			if (endLine - startLine + 1 < opts.minLines) continue;

			const hash = hashWindow(tokens, i, opts.minTokens);
			const key: WindowKey = { path: relPath, startIdx: i };
			const bucket = buckets.get(hash);
			if (bucket) bucket.push(key);
			else buckets.set(hash, [key]);
		}
	});

	// Re-verify each bucket by signature (filters hash collisions),
	// then extend each surviving group greedily forward + backward,
	// then dedupe groups whose extended footprint is identical.
	const seenKeys = new Set<string>();
	const collected: Array<{ tokens: number; windows: ExtendedWindow[] }> = [];

	for (const bucket of buckets.values()) {
		if (bucket.length < 2) continue;
		const bySig = new Map<string, WindowKey[]>();
		for (const w of bucket) {
			const tokens = fileTokens.get(w.path);
			if (!tokens) continue;
			const sig = signatureFor(tokens, w.startIdx, w.startIdx + opts.minTokens);
			const arr = bySig.get(sig);
			if (arr) arr.push(w);
			else bySig.set(sig, [w]);
		}
		for (const group of bySig.values()) {
			if (group.length < 2) continue;
			const extended = extendGroup(group, fileTokens, opts.minTokens);
			const collapsed = collapseSameFile(extended.windows);
			if (collapsed.length < 2) continue;
			const dedupKey = collapsed
				.map((w) => `${w.path}:${w.startIdx}:${w.length}`)
				.sort()
				.join("|");
			if (seenKeys.has(dedupKey)) continue;
			seenKeys.add(dedupKey);
			collected.push({ tokens: extended.tokens, windows: collapsed });
		}
	}

	const duplicates: Duplicate[] = collected.map((g) => ({
		files: g.windows
			.map<DupOccurrence>((w) => ({
				path: w.path,
				lines: [w.startLine, w.endLine],
			}))
			.sort((a, b) =>
				a.path === b.path
					? a.lines[0] - b.lines[0]
					: a.path.localeCompare(b.path),
			),
		tokens: g.tokens,
		similarity: 1.0,
	}));

	duplicates.sort((a, b) => {
		if (a.tokens !== b.tokens) return b.tokens - a.tokens;
		return a.files[0].path.localeCompare(b.files[0].path);
	});

	return { duplicates, skipped: skipped.sort() };
}

/**
 * Greedy bidirectional extension: walk all members forward (and
 * then backward) by the same offset while their tokens still
 * agree across the entire group. Bounded by the most-constrained
 * member's start/end-of-stream.
 */
function extendGroup(
	group: WindowKey[],
	fileTokens: Map<string, NormalizedToken[]>,
	minTokens: number,
): { tokens: number; windows: ExtendedWindow[] } {
	const ref = group[0];
	const refTokens = fileTokens.get(ref.path);
	if (!refTokens) {
		return {
			tokens: minTokens,
			windows: group.map((w) => toExtended(w, minTokens, fileTokens)),
		};
	}

	let forward = 0;
	while (true) {
		const refIdx = ref.startIdx + minTokens + forward;
		if (refIdx >= refTokens.length) break;
		const refTok = refTokens[refIdx].normalized;
		let allMatch = true;
		for (let i = 1; i < group.length; i++) {
			const w = group[i];
			const t = fileTokens.get(w.path);
			if (!t) {
				allMatch = false;
				break;
			}
			const idx = w.startIdx + minTokens + forward;
			if (idx >= t.length || t[idx].normalized !== refTok) {
				allMatch = false;
				break;
			}
		}
		if (!allMatch) break;
		forward++;
	}

	let backward = 0;
	while (true) {
		const refIdx = ref.startIdx - backward - 1;
		if (refIdx < 0) break;
		const refTok = refTokens[refIdx].normalized;
		let allMatch = true;
		for (let i = 1; i < group.length; i++) {
			const w = group[i];
			const t = fileTokens.get(w.path);
			if (!t) {
				allMatch = false;
				break;
			}
			const idx = w.startIdx - backward - 1;
			if (idx < 0 || t[idx].normalized !== refTok) {
				allMatch = false;
				break;
			}
		}
		if (!allMatch) break;
		backward++;
	}

	const length = minTokens + forward + backward;
	const windows = group.map<ExtendedWindow>((w) => {
		const t = fileTokens.get(w.path) ?? [];
		const start = w.startIdx - backward;
		return {
			path: w.path,
			startIdx: start,
			length,
			startLine: t[start]?.line ?? 0,
			endLine: t[start + length - 1]?.line ?? 0,
		};
	});
	return { tokens: length, windows };
}

function toExtended(
	w: WindowKey,
	length: number,
	fileTokens: Map<string, NormalizedToken[]>,
): ExtendedWindow {
	const t = fileTokens.get(w.path) ?? [];
	return {
		path: w.path,
		startIdx: w.startIdx,
		length,
		startLine: t[w.startIdx]?.line ?? 0,
		endLine: t[w.startIdx + length - 1]?.line ?? 0,
	};
}

/**
 * Drop overlapping windows in the SAME file: keep the lowest
 * `startIdx` and skip any whose token-index range intersects.
 */
function collapseSameFile(windows: ExtendedWindow[]): ExtendedWindow[] {
	const byFile = new Map<string, ExtendedWindow[]>();
	for (const w of windows) {
		const arr = byFile.get(w.path);
		if (arr) arr.push(w);
		else byFile.set(w.path, [w]);
	}
	const out: ExtendedWindow[] = [];
	for (const arr of byFile.values()) {
		arr.sort((a, b) => a.startIdx - b.startIdx);
		let last: ExtendedWindow | null = null;
		for (const w of arr) {
			if (last && w.startIdx < last.startIdx + last.length) continue;
			out.push(w);
			last = w;
		}
	}
	return out;
}

/**
 * Walk every leaf node, normalize, and emit a linear token stream.
 * `traversal.skip()` on `JSDoc` so doc-comment internals don't
 * leak into the token stream.
 */
function tokenize(sf: SourceFile): NormalizedToken[] {
	const tokens: NormalizedToken[] = [];
	sf.forEachDescendant((node, traversal) => {
		const kind = node.getKind();
		if (kind === SyntaxKind.JSDoc) {
			traversal.skip();
			return;
		}
		if (node.getChildCount() > 0) return;
		if (isTriviaKind(kind)) return;
		tokens.push({
			normalized: normalize(node),
			line: node.getStartLineNumber(),
		});
	});
	return tokens;
}

function isTriviaKind(kind: SyntaxKind): boolean {
	return (
		kind === SyntaxKind.SingleLineCommentTrivia ||
		kind === SyntaxKind.MultiLineCommentTrivia ||
		kind === SyntaxKind.WhitespaceTrivia ||
		kind === SyntaxKind.NewLineTrivia ||
		kind === SyntaxKind.JSDoc ||
		kind === SyntaxKind.EndOfFileToken
	);
}

function normalize(node: Node): string {
	if (Node.isIdentifier(node) || Node.isPrivateIdentifier(node)) {
		return "$id";
	}
	// Per spec AC + descriptor: literals (string/number/regex/template
	// parts) are preserved verbatim so two identical SQL queries with
	// different table names DON'T collapse.
	return node.getText();
}

function signatureFor(
	tokens: NormalizedToken[],
	start: number,
	end: number,
): string {
	const parts: string[] = [];
	for (let i = start; i < end; i++) {
		parts.push(tokens[i].normalized);
	}
	// NUL separator: defensive against tokens that contain whitespace
	// (e.g. JSX text nodes).
	return parts.join("\0");
}

/**
 * djb2 hash, 32-bit. Computed inline over the window so we never
 * retain the full signature string per window — only on demand
 * when re-verifying bucket members for a candidate match.
 */
function hashWindow(
	tokens: NormalizedToken[],
	start: number,
	length: number,
): number {
	let h = 5381;
	for (let i = 0; i < length; i++) {
		const t = tokens[start + i].normalized;
		for (let j = 0; j < t.length; j++) {
			h = ((h << 5) + h) ^ t.charCodeAt(j);
		}
		// Embed the NUL separator in the hash so adjacent windows
		// differ even when their token sequences look the same after
		// concatenation.
		h = ((h << 5) + h) ^ 0;
	}
	return h >>> 0;
}

function toForwardSlash(p: string): string {
	return p.replace(/\\/g, "/");
}
