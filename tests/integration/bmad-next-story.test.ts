/**
 * `bmad.next_story` integration test — Story 33.8.
 *
 * Builds a tmpdir scratch with epics.md + sprint-status.yaml and
 * asserts the dispatcher returns the first non-done story.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchBmad } from "../../src/tools/bmad.js";

interface NextStoryShape {
	story: { id: string; title: string; status: string } | null;
	confidence: string;
	knownGaps: string[];
}

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "bmad-next-"));
	mkdirSync(join(scratch, "_bmad-output", "implementation-artifacts"), {
		recursive: true,
	});
	mkdirSync(join(scratch, "_bmad-output", "planning-artifacts"));
	writeFileSync(
		join(scratch, "_bmad-output", "planning-artifacts", "epics.md"),
		[
			"## Epic 9: Next-story target",
			"### Story 9.1: First",
			"### Story 9.2: Second",
			"### Story 9.3: Third",
		].join("\n"),
	);
	writeFileSync(
		join(
			scratch,
			"_bmad-output",
			"implementation-artifacts",
			"sprint-status.yaml",
		),
		[
			"development_status:",
			"  9-1-first: done",
			"  9-2-second: ready-for-dev",
			"  9-3-third: backlog",
			"",
		].join("\n"),
	);
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("bmad.next_story", () => {
	it("returns the first non-done story walking epics in order", async () => {
		const result = (await dispatchBmad(
			scratch,
			"bmad.next_story",
			{},
		)) as NextStoryShape;
		expect(result.story).not.toBeNull();
		expect(result.story?.id).toBe("9.2");
	});

	it("returns story:null when every story is done", async () => {
		writeFileSync(
			join(
				scratch,
				"_bmad-output",
				"implementation-artifacts",
				"sprint-status.yaml",
			),
			[
				"development_status:",
				"  9-1-first: done",
				"  9-2-second: done",
				"  9-3-third: done",
				"",
			].join("\n"),
		);
		const result = (await dispatchBmad(
			scratch,
			"bmad.next_story",
			{},
		)) as NextStoryShape;
		expect(result.story).toBeNull();
	});
});
