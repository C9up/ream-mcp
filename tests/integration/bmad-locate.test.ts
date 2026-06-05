/**
 * `bmad.locate` integration test — Story 33.8.
 *
 * Runs against the live `_bmad-output/` of the repo and asserts
 * the default-tier path resolves correctly.
 */

import { describe, expect, it } from "vitest";

import { dispatchBmad } from "../../src/tools/bmad.js";
import { findReamRepoRoot } from "../test-utils.js";

const REAM_ROOT = findReamRepoRoot();

describe.skipIf(REAM_ROOT === null)("bmad.locate", () => {
	it("returns the live `_bmad-output/` path with tier=`default`", async () => {
		const result = (await dispatchBmad(
			REAM_ROOT as string,
			"bmad.locate",
			{},
		)) as {
			root: string;
			tier: string;
			candidates: Array<{ tier: string; path: string; exists: boolean }>;
			confidence: string;
			knownGaps: string[];
		};
		expect(result.tier).toBe("default");
		expect(result.root.endsWith("/_bmad-output")).toBe(true);
		expect(result.confidence).toBe("high");
		expect(result.candidates.map((c) => c.tier)).toEqual([
			"reamrc",
			"env",
			"default",
			"legacy",
			"flat",
		]);
	});
});
