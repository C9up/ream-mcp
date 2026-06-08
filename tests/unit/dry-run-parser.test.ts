import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	isConflictPayload,
	isDryRunPayload,
	isWrittenPayload,
	normalizePlannedFile,
	parseTrailingJson,
} from "../../src/util/dry-run.js";

describe("parseTrailingJson — strict last-line parser", () => {
	it("returns the parsed last JSON object", () => {
		const stdout =
			'progress: building\nignore me\n{"files":[],"warnings":[]}\n';
		expect(parseTrailingJson(stdout)).toEqual({ files: [], warnings: [] });
	});

	it("rejects when the trailing line is not JSON, even if an earlier line is", () => {
		// Strict mode: the trailing line is the contract. We do NOT walk
		// upward looking for an earlier valid line.
		const stdout =
			'first\n{"files":[],"warnings":[]}\nsome trailing log line\n';
		expect(() => parseTrailingJson(stdout)).toThrow(/not valid JSON/i);
	});

	it("rejects when trailing line is JSON but not an object", () => {
		expect(() => parseTrailingJson("progress\n42\n")).toThrow(/not an object/i);
		expect(() => parseTrailingJson('progress\n"string"\n')).toThrow(
			/not an object/i,
		);
		expect(() => parseTrailingJson("progress\n[1,2]\n")).toThrow(
			/not an object/i,
		);
		expect(() => parseTrailingJson("progress\nnull\n")).toThrow(
			/not an object/i,
		);
	});

	it("throws when no non-empty line is present", () => {
		expect(() => parseTrailingJson("\n\n   \n")).toThrow(/parseable JSON/i);
	});
});

describe("type guards — mutual exclusivity", () => {
	it("isDryRunPayload rejects payloads with foreign keys", () => {
		expect(isDryRunPayload({ files: [], warnings: [] })).toBe(true);
		expect(
			isDryRunPayload({
				createdFiles: [],
				modifiedFiles: [],
				warnings: [],
			}),
		).toBe(false);
		expect(isDryRunPayload({ error: "x", hint: "y", conflicts: [] })).toBe(
			false,
		);
		// Superset payload that would have passed the old guard:
		expect(
			isDryRunPayload({
				files: [],
				warnings: [],
				createdFiles: [],
			}),
		).toBe(false);
	});

	it("isWrittenPayload rejects payloads carrying dry-run/conflict keys", () => {
		expect(
			isWrittenPayload({
				createdFiles: ["a"],
				modifiedFiles: [],
				warnings: [],
			}),
		).toBe(true);
		expect(isWrittenPayload({ createdFiles: [] })).toBe(false);
		expect(
			isWrittenPayload({
				createdFiles: [],
				modifiedFiles: [],
				warnings: [],
				files: [],
			}),
		).toBe(false);
	});

	it("isConflictPayload rejects payloads carrying foreign keys", () => {
		expect(
			isConflictPayload({
				error: "e",
				hint: "h",
				conflicts: ["a"],
			}),
		).toBe(true);
		expect(isConflictPayload({ error: "e", hint: "h" })).toBe(false);
		expect(
			isConflictPayload({
				error: "e",
				hint: "h",
				conflicts: [],
				files: [],
			}),
		).toBe(false);
	});
});

describe("normalizePlannedFile — UTF-8 byte-aware", () => {
	it("normalizes backslashes and passes small content through", () => {
		const out = normalizePlannedFile(
			{ path: "app\\orders\\Order.ts", content: "x", exists: false },
			null,
		);
		expect(out.truncated).toBe(false);
		expect(out.file.path).toBe("app/orders/Order.ts");
		expect(out.file.content).toBe("x");
		expect(out.file.contentTruncated).toBeUndefined();
	});

	it("truncates content above 8KB and spills to overflowPath thunk", () => {
		const dir = mkdtempSync(join(tmpdir(), "ream-mcp-overflow-"));
		const overflowFile = join(dir, "overflow.log");
		writeFileSync(overflowFile, ""); // touch
		const big = "x".repeat(10_000);
		const out = normalizePlannedFile(
			{ path: "big.ts", content: big, exists: false },
			() => overflowFile,
		);
		expect(out.truncated).toBe(true);
		expect(out.file.contentTruncated).toBe(true);
		// Truncated content includes a small trailing marker; allow up
		// to ~64 chars of slack.
		expect(out.file.content.length).toBeLessThanOrEqual(8_192 + 64);
		const spilled = readFileSync(overflowFile, "utf8");
		expect(spilled).toContain(big);
		expect(spilled).toContain("(full content)");
	});

	it("counts BYTES not UTF-16 code units, and truncates on a code-point boundary", () => {
		// 4-byte UTF-8 char (emoji) — 2048 of them = 8192 bytes exactly.
		// Add one more to push past the cap.
		const emoji = "🦀"; // U+1F980, 4 bytes UTF-8
		const content = emoji.repeat(2049); // 8196 bytes
		const out = normalizePlannedFile(
			{ path: "rust.ts", content, exists: false },
			null,
		);
		expect(out.truncated).toBe(true);
		// The truncated content must NOT end with an orphaned surrogate
		// half — JSON.stringify must succeed.
		expect(() => JSON.stringify(out.file.content)).not.toThrow();
		// The trailing marker is appended after the truncated body, so
		// content.length is body + marker.
		expect(out.file.content).toContain("…[truncated");
	});
});
