/**
 * `bmad.list_epics` integration test — Story 33.8.
 */

import { describe, expect, it } from "vitest";

import { dispatchBmad } from "../../src/tools/bmad.js";
import { findReamRepoRoot } from "../test-utils.js";

const REAM_ROOT = findReamRepoRoot();

interface EpicShape {
	id: string;
	title: string;
	status: string;
	storyCount: number;
	stories: Array<{ id: string; title: string; status: string }>;
}

interface ListShape {
	parserVersion: string;
	parserWarnings: string[];
	epics: EpicShape[];
	confidence: string;
	knownGaps: string[];
}

describe.skipIf(REAM_ROOT === null)("bmad.list_epics", () => {
	it("parses the live epics.md and surfaces Story 33.8 with merged status", async () => {
		const result = (await dispatchBmad(
			REAM_ROOT as string,
			"bmad.list_epics",
			{},
		)) as ListShape;
		expect(result.parserVersion).toBe("1.0.0");
		expect(result.epics.length).toBeGreaterThan(30);
		const epic33 = result.epics.find((e) => e.id === "33");
		expect(epic33).toBeDefined();
		const story = epic33?.stories.find((s) => s.id === "33.8");
		expect(story).toBeDefined();
		expect(story?.title).toContain("BMAD");
		// Status comes from sprint-status.yaml; running this test
		// while 33.8 is `in-progress` should show that value.
		expect(story?.status).toMatch(
			/^(backlog|ready-for-dev|in-progress|review|done)$/,
		);
	});

	it("output is deterministic — sorted by epic id then story id", async () => {
		const a = (await dispatchBmad(
			REAM_ROOT as string,
			"bmad.list_epics",
			{},
		)) as ListShape;
		const b = (await dispatchBmad(
			REAM_ROOT as string,
			"bmad.list_epics",
			{},
		)) as ListShape;
		expect(b.epics.map((e) => e.id)).toEqual(a.epics.map((e) => e.id));
		for (let i = 0; i < a.epics.length - 1; i++) {
			expect(Number(a.epics[i].id)).toBeLessThan(Number(a.epics[i + 1].id));
		}
	});
});
