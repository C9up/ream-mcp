/**
 * Line-targeted YAML rewriter — Story 33.8.
 *
 * Pulling in `js-yaml` for `sprint-status.yaml` would re-format
 * comments and re-order keys. The file is hand-edited prose, so
 * we treat it as text: locate the exact `<key>: <value>` line by
 * regex, swap only the value, preserve the leading indent, the
 * trailing comment (if any), and the line-ending.
 *
 * `atomicWrite` writes via a sibling tempfile + `fsync` + `rename`
 * — atomic on POSIX. On Windows the same-dir rename is best-
 * effort (Node falls back to `copyFile + unlink`), surfaced as a
 * documented gap by the dispatcher.
 */

import {
	closeSync,
	fsyncSync,
	openSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface FoundLine {
	lineNumber: number;
	indent: string;
	key: string;
	value: string;
	trailingComment: string;
	lineEnding: string;
	original: string;
}

/**
 * Locate the line `<indent><key>: <value>[#comment]<lineEnding>`
 * inside `text`. Returns `null` if the key is not present at the
 * scanned indentation level. The matcher requires the key to
 * appear at the start of a line (after optional indent) and to
 * be followed by a colon — comment lines starting with `#` are
 * skipped before the match.
 */
export function findStatusLine(
	text: string,
	key: string,
	options: { requireIndent?: boolean } = {},
): FoundLine | null {
	const lines = text.split(/(\r\n|\n)/); // keep separators
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^(\\s*)(${escapedKey}):\\s*([^#\\n]*?)(\\s*#.*)?$`);
	let lineNumber = 0;
	for (let i = 0; i < lines.length; i += 2) {
		const content = lines[i] ?? "";
		const sep = lines[i + 1] ?? "";
		lineNumber += 1;
		// Skip comment-only lines so a key buried inside a comment
		// does not hijack the match.
		if (/^\s*#/.test(content)) continue;
		const m = re.exec(content);
		if (!m) continue;
		const indent = m[1] ?? "";
		// `requireIndent` scopes the search to keys nested under a
		// parent block, preventing top-level metadata (`generated`,
		// `last_updated`) from being rewritten by `bmad.update_status`.
		if (options.requireIndent && indent.length === 0) continue;
		const matchedKey = m[2] ?? "";
		const value = (m[3] ?? "").replace(/\s+$/, "");
		const trailingComment = m[4] ?? "";
		return {
			lineNumber,
			indent,
			key: matchedKey,
			value,
			trailingComment,
			lineEnding: sep,
			original: content,
		};
	}
	return null;
}

export interface ReplaceResult {
	changed: boolean;
	text: string;
	before: string;
	after: string;
	lineNumber: number;
}

/**
 * Replace the value associated with `key` by `newValue`, leaving
 * everything else (indent, comment, line-ending, surrounding
 * lines) byte-for-byte identical. Returns `changed: false` when
 * the key is absent or the value already matches.
 */
export function replaceStatusLine(
	text: string,
	key: string,
	newValue: string,
	options: { requireIndent?: boolean } = {},
): ReplaceResult {
	const found = findStatusLine(text, key, options);
	if (!found) {
		return {
			changed: false,
			text,
			before: "",
			after: "",
			lineNumber: 0,
		};
	}
	const before = `${found.indent}${found.key}: ${found.value}${found.trailingComment}`;
	const after = `${found.indent}${found.key}: ${newValue}${found.trailingComment}`;
	if (before === after) {
		return {
			changed: false,
			text,
			before,
			after,
			lineNumber: found.lineNumber,
		};
	}
	// Reconstruct by line-number rather than text-replace to avoid
	// catastrophic mismatches when the same key text appears later
	// in a comment.
	const lines = text.split(/(\r\n|\n)/);
	const idx = (found.lineNumber - 1) * 2;
	lines[idx] = after;
	return {
		changed: true,
		text: lines.join(""),
		before,
		after,
		lineNumber: found.lineNumber,
	};
}

/**
 * Write `content` to `filePath` atomically: same-dir tempfile,
 * `fsync`, `rename`. Tempfile is unlinked if `rename` throws.
 */
export function atomicWrite(filePath: string, content: string): void {
	const dir = dirname(filePath);
	const tmp = join(
		dir,
		`.${basename(filePath)}.tmp.${process.pid}.${Date.now()}.${Math.random()
			.toString(36)
			.slice(2, 8)}`,
	);
	let fd: number | null = null;
	try {
		fd = openSync(tmp, "wx");
		writeSync(fd, content);
		fsyncSync(fd);
		closeSync(fd);
		fd = null;
		renameSync(tmp, filePath);
	} catch (err) {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				/* ignore */
			}
		}
		try {
			unlinkSync(tmp);
		} catch {
			/* ignore — tempfile may already be moved or never created */
		}
		throw err;
	}
}
