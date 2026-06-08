/**
 * `bmad.gap_report` integration test — Story 33.8.
 *
 * Builds a tiny tmpdir project with two stories where one has
 * code references and one has none.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchBmad } from "../../src/tools/bmad.js";

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "bmad-gap-"));
	mkdirSync(join(scratch, "_bmad-output", "implementation-artifacts"), {
		recursive: true,
	});
	mkdirSync(join(scratch, "_bmad-output", "planning-artifacts"));
	writeFileSync(
		join(scratch, "package.json"),
		JSON.stringify({ name: "scratch", version: "0.0.0", private: true }),
	);
	mkdirSync(join(scratch, "src"));
	// Story 1.1 has a code reference; Story 1.2 has none.
	writeFileSync(
		join(scratch, "src", "covered.ts"),
		"// Implements story 1.1\nexport const x = 1;\n",
	);
	writeFileSync(
		join(scratch, "_bmad-output", "planning-artifacts", "epics.md"),
		[
			"## Epic 1: Test",
			"### Story 1.1: Covered (implements FR-1)",
			"### Story 1.2: Uncovered",
		].join("\n"),
	);
	writeFileSync(
		join(scratch, "_bmad-output", "planning-artifacts", "prd.md"),
		[
			"# PRD",
			"FR-1: implemented requirement (mentioned in story 1.1)",
			"FR-2: orphan requirement",
		].join("\n"),
	);
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

interface GapShape {
	requirementsWithoutStories: Array<{
		id: string;
		sourceFile: string;
		line: number;
	}>;
	storiesWithoutCode: Array<{ id: string; title: string }>;
	storiesWithoutTests: Array<{ id: string; title: string }>;
	confidence: string;
	knownGaps: string[];
}

describe("bmad.gap_report", () => {
	it("flags the story without code references and the orphan requirement", async () => {
		const result = (await dispatchBmad(
			scratch,
			"bmad.gap_report",
			{},
		)) as GapShape;
		const codeIds = result.storiesWithoutCode.map((s) => s.id);
		expect(codeIds).toContain("1.2");
		expect(codeIds).not.toContain("1.1");
		const reqIds = result.requirementsWithoutStories.map((r) => r.id);
		expect(reqIds).toContain("FR-2");
		expect(reqIds).not.toContain("FR-1");
		// Both stories lack tests in this fixture.
		expect(result.storiesWithoutTests.map((s) => s.id)).toEqual(
			expect.arrayContaining(["1.1", "1.2"]),
		);
	});
});
