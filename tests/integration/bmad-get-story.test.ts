/**
 * `bmad.get_story` integration test, on the committed BMAD fixture: the
 * implementation-artifact path for `33.7` and the epic-section fallback for
 * `35.9`, which has no artifact file.
 */

import { describe, expect, it } from "vitest";

import { dispatchBmad } from "../../src/tools/bmad.js";
import { BMAD_FIXTURE_ROOT } from "../test-utils.js";

function story(id: string) {
	return dispatchBmad(BMAD_FIXTURE_ROOT, "bmad.get_story", { id });
}

describe("bmad.get_story", () => {
	it("returns the implementation-artifact body for `33.7`", async () => {
		const result = await story("33.7");
		expect(result).toMatchObject({
			source: "implementation-artifact",
			id: "33.7",
			title: "Story 33.7: Security hardening of the MCP server",
			status: "done",
			filePath: "implementation-artifacts/33-7-security-hardening.md",
		});
		expect(result).toHaveProperty(
			"body",
			expect.stringContaining("the security review is closed"),
		);
	});

	it("falls back to the epic section for a story without an artifact file", async () => {
		const result = await story("35.9");
		expect(result).toMatchObject({
			source: "epic-section",
			id: "35.9",
			title: "Audit spin-out documented in the epic",
			status: "review",
			filePath: "planning-artifacts/epics.md",
		});
		expect(result).toHaveProperty(
			"body",
			expect.stringContaining("there is no artifact file"),
		);
	});

	it("rejects malformed story ids", async () => {
		for (const id of ["abc", "33", "33.7.1", "../33.7"]) {
			expect(await story(id)).toMatchObject({
				error: expect.stringContaining("invalid id"),
				confidence: "low",
			});
		}
	});

	it("returns a structured error for an unknown story id", async () => {
		expect(await story("999.99")).toMatchObject({
			error: expect.stringContaining("not found"),
		});
	});
});
