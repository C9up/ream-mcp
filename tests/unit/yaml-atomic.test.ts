/**
 * Unit tests for the YAML line-rewriter — Story 33.8.
 *
 * Pure-function tests for `findStatusLine` / `replaceStatusLine`,
 * plus an integration-style test for `atomicWrite` against a
 * tmpdir.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	atomicWrite,
	findStatusLine,
	replaceStatusLine,
} from "../../src/util/yaml-atomic.js";

const SAMPLE = [
	"# header comment",
	"generated: 2026-03-27",
	"last_updated: 2026-04-29",
	"# inline comment line",
	"development_status:",
	"  33-1-mcp-stdio: done",
	"  33-7-security-scanners-targeted: done",
	"  33-8-bmad-bridge-and-doctor: in-progress  # tracking comment",
	"  35-1-decimal-core: done",
	"trailing: top-level",
	"",
].join("\n");

describe("findStatusLine", () => {
	it("locates a key with a trailing comment, preserving structure", () => {
		const found = findStatusLine(SAMPLE, "33-8-bmad-bridge-and-doctor");
		expect(found).not.toBeNull();
		expect(found?.lineNumber).toBe(8);
		expect(found?.indent).toBe("  ");
		expect(found?.value).toBe("in-progress");
		expect(found?.trailingComment).toBe("  # tracking comment");
	});

	it("locates a key without a trailing comment", () => {
		const found = findStatusLine(SAMPLE, "33-1-mcp-stdio");
		expect(found?.value).toBe("done");
		expect(found?.trailingComment).toBe("");
	});

	it("returns null when the key is absent", () => {
		const found = findStatusLine(SAMPLE, "99-9-missing");
		expect(found).toBeNull();
	});

	it("does not match keys hiding inside a comment line", () => {
		const text = [
			"# 33-8-bmad-bridge-and-doctor: should not match",
			"  33-8-bmad-bridge-and-doctor: in-progress",
		].join("\n");
		const found = findStatusLine(text, "33-8-bmad-bridge-and-doctor");
		expect(found?.lineNumber).toBe(2);
		expect(found?.value).toBe("in-progress");
	});
});

describe("replaceStatusLine", () => {
	it("replaces the value, preserving every other byte", () => {
		const r = replaceStatusLine(
			SAMPLE,
			"33-8-bmad-bridge-and-doctor",
			"review",
		);
		expect(r.changed).toBe(true);
		expect(r.lineNumber).toBe(8);
		// Diff must show ONLY the value change.
		expect(r.before).toBe(
			"  33-8-bmad-bridge-and-doctor: in-progress  # tracking comment",
		);
		expect(r.after).toBe(
			"  33-8-bmad-bridge-and-doctor: review  # tracking comment",
		);
		// Every other line is byte-identical.
		const beforeLines = SAMPLE.split("\n");
		const afterLines = r.text.split("\n");
		expect(beforeLines).toHaveLength(afterLines.length);
		for (let i = 0; i < beforeLines.length; i++) {
			if (i === 7) continue; // line index for line number 8
			expect(afterLines[i]).toBe(beforeLines[i]);
		}
	});

	it("returns changed: false when the value already matches", () => {
		const r = replaceStatusLine(SAMPLE, "33-1-mcp-stdio", "done");
		expect(r.changed).toBe(false);
		expect(r.text).toBe(SAMPLE);
	});

	it("round-trips: read → re-encode-with-same-value yields identical bytes", () => {
		const r = replaceStatusLine(SAMPLE, "33-1-mcp-stdio", "done");
		expect(r.text).toBe(SAMPLE);
	});
});

describe("atomicWrite", () => {
	let dir: string;
	let target: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "yaml-atomic-"));
		target = join(dir, "sprint-status.yaml");
		writeFileSync(target, SAMPLE);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes the new content and leaves the file at the target path", () => {
		const r = replaceStatusLine(
			SAMPLE,
			"33-8-bmad-bridge-and-doctor",
			"review",
		);
		atomicWrite(target, r.text);
		const written = readFileSync(target, "utf8");
		expect(written).toBe(r.text);
		// Diff is exactly one value swap.
		expect(written.split("\n")[7]).toContain("review");
	});

	it("does not leave a stray tempfile behind on success", async () => {
		atomicWrite(target, "x");
		const { readdirSync } = await import("node:fs");
		const entries = readdirSync(dir);
		const tmps = entries.filter((e) => e.includes(".tmp."));
		expect(tmps).toEqual([]);
	});

	it("rolls back cleanly when the rename target points to a non-existent dir", async () => {
		const { readdirSync } = await import("node:fs");
		const bogus = join(dir, "no-such-subdir", "sprint-status.yaml");
		expect(() => atomicWrite(bogus, "y")).toThrow(Error);
		// The original file is untouched and no tempfile leaks in
		// the parent directory.
		expect(readFileSync(target, "utf8")).toBe(SAMPLE);
		const tmps = readdirSync(dir).filter((e) => e.includes(".tmp."));
		expect(tmps).toEqual([]);
	});
});
