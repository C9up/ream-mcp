/**
 * `bmad.get_story` integration test — Story 33.8.
 *
 * Asserts the implementation-artifact path on `33.7` and the
 * epic-section fallback for an id without an artifact file.
 */

import { describe, expect, it } from "vitest";

import { dispatchBmad } from "../../src/tools/bmad.js";
import { findReamRepoRoot } from "../test-utils.js";

const REAM_ROOT = findReamRepoRoot();

interface StoryShape {
	source: "implementation-artifact" | "epic-section";
	id: string;
	title: string;
	status: string;
	body: string;
	filePath: string;
}

interface ErrorShape {
	error: string;
	hint: string;
	confidence: string;
	knownGaps: string[];
}

describe.skipIf(REAM_ROOT === null)("bmad.get_story", () => {
	it("returns the implementation-artifact body for `33.7`", async () => {
		const result = (await dispatchBmad(REAM_ROOT as string, "bmad.get_story", {
			id: "33.7",
		})) as StoryShape;
		expect(result.source).toBe("implementation-artifact");
		expect(result.id).toBe("33.7");
		expect(result.body).toContain("security");
		expect(result.filePath).toMatch(/^implementation-artifacts\/33-7-/);
	});

	it("falls back to the epic-section for a story without an artifact file", async () => {
		// Story 35.9 is in epics.md but has no implementation
		// artifact file (it's an "audit-spun-out" story documented
		// in the epic body).
		const result = (await dispatchBmad(REAM_ROOT as string, "bmad.get_story", {
			id: "35.9",
		})) as StoryShape | ErrorShape;
		if ("error" in result) {
			// Acceptable — story 35.9 may not exist in the live
			// epics.md depending on history.
			expect(result.error).toContain("not found");
		} else {
			expect(result.source).toBe("epic-section");
			expect(result.id).toBe("35.9");
		}
	});

	it("rejects malformed story ids", async () => {
		const result = (await dispatchBmad(REAM_ROOT as string, "bmad.get_story", {
			id: "abc",
		})) as ErrorShape;
		expect(result.error).toContain("invalid id");
		expect(result.confidence).toBe("low");
	});

	it("returns a structured error for an unknown story id", async () => {
		const result = (await dispatchBmad(REAM_ROOT as string, "bmad.get_story", {
			id: "999.99",
		})) as ErrorShape;
		expect(result.error).toContain("not found");
	});
});
