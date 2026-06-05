/**
 * Parses the JSON line emitted by `ream-cli` after a `--dry-run` or
 * actual write. Story 33.4 contract: the CLI prints exactly ONE JSON
 * OBJECT on its own line as the LAST non-empty line of stdout.
 *
 * Per-file content cap: 8 KB **bytes** (UTF-8). Files exceeding the
 * cap have their `content` field truncated on a UTF-8 boundary, with
 * a `contentTruncated: true` flag and the full body spilled to the
 * caller-supplied overflow file.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_FILE_CONTENT_BYTES = 8_192;

export interface PlannedFile {
	path: string;
	content: string;
	exists: boolean;
	contentTruncated?: boolean;
}

export interface DryRunPayload {
	files: PlannedFile[];
	warnings: string[];
}

export interface WrittenPayload {
	createdFiles: string[];
	modifiedFiles: string[];
	warnings: string[];
}

export interface ConflictPayload {
	error: string;
	hint: string;
	conflicts: string[];
}

/**
 * Pull the LAST parseable JSON OBJECT from stdout. Strict:
 *   - Returns ONLY the trailing line; if it's not parseable as JSON or
 *     is not a non-array object, throws — does NOT silently fall back
 *     to earlier lines.
 *   - This avoids the "stub-binary-emits-an-info-line" footgun where a
 *     tail status line happens to be valid JSON.
 */
export function parseTrailingJson(stdout: string): Record<string, unknown> {
	const lines = stdout.split("\n");
	let trailing: string | null = null;
	for (let i = lines.length - 1; i >= 0; i--) {
		const trimmed = lines[i].trim();
		if (trimmed.length > 0) {
			trailing = trimmed;
			break;
		}
	}
	if (trailing === null) {
		throw new Error(
			"ream-mcp: cli stdout did not contain a parseable JSON object on its last line",
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trailing);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(
			`ream-mcp: trailing line of cli stdout is not valid JSON: ${detail}`,
		);
	}
	if (!isObject(parsed)) {
		throw new Error(
			"ream-mcp: cli stdout trailing line is JSON but not an object",
		);
	}
	return parsed;
}

/**
 * Mutually exclusive type guards. The three CLI payload shapes share
 * field names by accident (e.g. all carry `warnings`); each guard
 * additionally rejects keys belonging to the other shapes so a
 * malformed-but-superset payload can't pass two guards at once.
 */
export function isDryRunPayload(value: unknown): value is DryRunPayload {
	if (!isObject(value)) return false;
	if (!Array.isArray(value.files)) return false;
	if (!Array.isArray(value.warnings)) return false;
	if ("createdFiles" in value || "modifiedFiles" in value) return false;
	if ("error" in value || "conflicts" in value) return false;
	return true;
}

export function isWrittenPayload(value: unknown): value is WrittenPayload {
	if (!isObject(value)) return false;
	if (!Array.isArray(value.createdFiles)) return false;
	if (!Array.isArray(value.modifiedFiles)) return false;
	if ("files" in value) return false;
	if ("error" in value || "conflicts" in value) return false;
	return true;
}

export function isConflictPayload(value: unknown): value is ConflictPayload {
	if (!isObject(value)) return false;
	if (typeof value.error !== "string") return false;
	if (typeof value.hint !== "string") return false;
	if (!Array.isArray(value.conflicts)) return false;
	if ("files" in value || "createdFiles" in value || "modifiedFiles" in value)
		return false;
	return true;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Allocate a fresh per-call overflow file under tmpdir. Lazy: returns
 * a getter that creates the file only when first invoked, so happy-path
 * dry-runs never touch the filesystem.
 */
export function makeOverflowSink(): {
	path: () => string;
} {
	let cached: string | null = null;
	return {
		path: () => {
			if (cached === null) {
				const dir = mkdtempSync(join(tmpdir(), "ream-mcp-dryrun-"));
				cached = join(dir, "planned-files.log");
				// Touch the file so subsequent appends always succeed.
				try {
					writeFileSync(cached, "");
				} catch {
					/* deliberately swallowed — append will surface the error */
				}
			}
			return cached;
		},
	};
}

/**
 * Normalize a path to forward-slash, then enforce the 8 KB BYTE cap.
 * UTF-8 aware: truncates on a code-point boundary (no broken sequences,
 * no orphaned surrogates) and counts bytes, not UTF-16 code units.
 */
export function normalizePlannedFile(
	file: PlannedFile,
	getOverflowPath: (() => string) | null,
): { file: PlannedFile; truncated: boolean } {
	const path = file.path.replace(/\\/g, "/");
	const byteLen = Buffer.byteLength(file.content, "utf8");
	if (byteLen <= MAX_FILE_CONTENT_BYTES) {
		return { file: { ...file, path }, truncated: false };
	}
	if (getOverflowPath) {
		try {
			const overflowPath = getOverflowPath();
			const banner = `\n\n=== ${path} (full content) ===\n`;
			writeFileSync(overflowPath, banner + file.content, { flag: "a" });
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			process.stderr.write(
				`[ream-mcp] failed to spill planned-file overflow: ${detail}\n`,
			);
		}
	}
	const headBytes = Buffer.from(file.content, "utf8").subarray(
		0,
		MAX_FILE_CONTENT_BYTES,
	);
	// Buffer.toString("utf8") on a slice that ends mid-code-point emits
	// U+FFFD replacement chars — that's safe and preserves valid JSON
	// output, but for a cleaner truncation we trim back to the last
	// well-formed code point boundary.
	const decoded = safeUtf8Decode(headBytes);
	return {
		file: {
			path,
			content: `${decoded}\n…[truncated — see plannedFilesOverflowPath]`,
			exists: file.exists,
			contentTruncated: true,
		},
		truncated: true,
	};
}

/**
 * Decode a byte slice as UTF-8, dropping any trailing partial code
 * point. Avoids the U+FFFD replacement char that Buffer.toString
 * inserts for incomplete sequences at the boundary.
 */
function safeUtf8Decode(buf: Buffer): string {
	if (buf.length === 0) return "";
	// UTF-8 continuation bytes match 10xxxxxx (0x80-0xBF). Walk back
	// from the end past any continuations to find the start of the
	// last code point.
	let end = buf.length;
	while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) {
		end -= 1;
	}
	// Now buf[end-1] is a code-point start byte. If the resulting
	// length doesn't match the expected sequence, drop the start byte
	// too.
	if (end > 0) {
		const lead = buf[end - 1];
		const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
		if (buf.length - (end - 1) < expected) {
			end -= 1;
		}
	}
	return buf.subarray(0, end).toString("utf8");
}
