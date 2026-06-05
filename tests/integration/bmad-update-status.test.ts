/**
 * `bmad.update_status` integration test — Story 33.8.
 *
 * Builds a tmpdir scratch with a stub `_bmad-output/` containing
 * a synthetic sprint-status.yaml + epics.md. Drives the dispatch
 * end-to-end through dry-run, consent-refused, and real-write
 * paths.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchBmad } from "../../src/tools/bmad.js";

const SAMPLE_YAML = [
	"# Sprint Status",
	"generated: 2026-03-27",
	"last_updated: 2026-04-29",
	"development_status:",
	"  33-1-foo: done",
	"  33-8-bmad-bridge-and-doctor: in-progress  # tracking comment",
	"  35-1-decimal: done",
	"trailing: x",
	"",
].join("\n");

const SAMPLE_EPICS = [
	"# Epics",
	"## Epic 33: Ream MCP",
	"### Story 33.8: BMAD bridge",
	"body",
].join("\n");

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "bmad-update-"));
	mkdirSync(join(scratch, "_bmad-output", "implementation-artifacts"), {
		recursive: true,
	});
	mkdirSync(join(scratch, "_bmad-output", "planning-artifacts"));
	writeFileSync(
		join(
			scratch,
			"_bmad-output",
			"implementation-artifacts",
			"sprint-status.yaml",
		),
		SAMPLE_YAML,
	);
	writeFileSync(
		join(scratch, "_bmad-output", "planning-artifacts", "epics.md"),
		SAMPLE_EPICS,
	);
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

interface DiffShape {
	diff: { file: string; lineNumber: number; before: string; after: string };
	applied: boolean;
	confidence: string;
	knownGaps: string[];
}

interface ErrorShape {
	error: string;
	hint: string;
	confidence: string;
	knownGaps: string[];
}

describe("bmad.update_status", () => {
	it("dry-run returns the diff without mutating the file", async () => {
		const result = (await dispatchBmad(scratch, "bmad.update_status", {
			id: "33-8-bmad-bridge-and-doctor",
			status: "review",
		})) as DiffShape;
		expect(result.applied).toBe(false);
		expect(result.diff.before).toContain("in-progress");
		expect(result.diff.after).toContain("review");
		const onDisk = readFileSync(
			join(
				scratch,
				"_bmad-output",
				"implementation-artifacts",
				"sprint-status.yaml",
			),
			"utf8",
		);
		expect(onDisk).toBe(SAMPLE_YAML);
	});

	it("refuses dryRun:false without confirm:true", async () => {
		const result = (await dispatchBmad(scratch, "bmad.update_status", {
			id: "33-8-bmad-bridge-and-doctor",
			status: "review",
			dryRun: false,
		})) as ErrorShape;
		expect(result.error).toContain("confirm");
	});

	it("rejects an invalid status with a structured error", async () => {
		const result = (await dispatchBmad(scratch, "bmad.update_status", {
			id: "33-8-bmad-bridge-and-doctor",
			status: "wat",
		})) as ErrorShape;
		expect(result.error).toContain("invalid status");
	});

	it("rejects an unknown story id", async () => {
		const result = (await dispatchBmad(scratch, "bmad.update_status", {
			id: "99-9-missing",
			status: "done",
		})) as ErrorShape;
		expect(result.error).toContain("not found");
	});

	it("writes atomically and preserves every other byte", async () => {
		const result = (await dispatchBmad(scratch, "bmad.update_status", {
			id: "33-8-bmad-bridge-and-doctor",
			status: "review",
			dryRun: false,
			confirm: true,
		})) as DiffShape;
		expect(result.applied).toBe(true);
		const after = readFileSync(
			join(
				scratch,
				"_bmad-output",
				"implementation-artifacts",
				"sprint-status.yaml",
			),
			"utf8",
		);
		const beforeLines = SAMPLE_YAML.split("\n");
		const afterLines = after.split("\n");
		expect(afterLines).toHaveLength(beforeLines.length);
		// Only the targeted line changed.
		for (let i = 0; i < beforeLines.length; i++) {
			if (i === 5) {
				expect(afterLines[i]).toContain("review");
				expect(afterLines[i]).toContain("# tracking comment");
			} else {
				expect(afterLines[i]).toBe(beforeLines[i]);
			}
		}
	});
});
