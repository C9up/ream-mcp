/**
 * `bmad.list_epics` integration test, on the committed BMAD fixture.
 */

import { describe, expect, it } from "vitest";

import { dispatchBmad } from "../../src/tools/bmad.js";
import { BMAD_FIXTURE_ROOT } from "../test-utils.js";

describe("bmad.list_epics", () => {
	it("parses epics.md and merges the statuses of sprint-status.yaml", async () => {
		const result = await dispatchBmad(BMAD_FIXTURE_ROOT, "bmad.list_epics", {});
		expect(result).toMatchObject({
			parserVersion: "1.0.0",
			parserWarnings: [],
			epics: [
				{
					id: "33",
					title: "Agent tooling",
					status: "in-progress",
					storyCount: 2,
					stories: [
						{
							id: "33.7",
							title: "Security hardening of the MCP server",
							status: "done",
						},
						{
							id: "33.8",
							title: "BMAD tools for the agent",
							status: "in-progress",
						},
					],
				},
				{
					id: "34",
					status: "backlog",
					stories: [{ id: "34.1", status: "backlog" }],
				},
				{
					id: "35",
					status: "backlog",
					stories: [{ id: "35.9", status: "review" }],
				},
			],
		});
	});

	it("is deterministic across calls", async () => {
		const a = await dispatchBmad(BMAD_FIXTURE_ROOT, "bmad.list_epics", {});
		const b = await dispatchBmad(BMAD_FIXTURE_ROOT, "bmad.list_epics", {});
		expect(b).toEqual(a);
	});
});
