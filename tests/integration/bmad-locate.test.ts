/**
 * `bmad.locate` integration test, on the committed BMAD fixture: with no
 * reamrc entry and no `REAM_BMAD_ROOT`, the default tier resolves.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchBmad } from "../../src/tools/bmad.js";
import { BMAD_FIXTURE_ROOT } from "../test-utils.js";

const saved = process.env.REAM_BMAD_ROOT;

beforeEach(() => {
	delete process.env.REAM_BMAD_ROOT;
});

afterEach(() => {
	if (saved === undefined) delete process.env.REAM_BMAD_ROOT;
	else process.env.REAM_BMAD_ROOT = saved;
});

describe("bmad.locate", () => {
	it("returns the `_bmad-output/` path with tier=`default`", async () => {
		const result = await dispatchBmad(BMAD_FIXTURE_ROOT, "bmad.locate", {});
		expect(result).toMatchObject({
			tier: "default",
			root: expect.stringMatching(/(^|[\\/])_bmad-output$/),
			confidence: "high",
		});
		expect(result).toHaveProperty("candidates", [
			expect.objectContaining({ tier: "reamrc" }),
			expect.objectContaining({ tier: "env" }),
			expect.objectContaining({ tier: "default", exists: true }),
			expect.objectContaining({ tier: "legacy" }),
			expect.objectContaining({ tier: "flat" }),
		]);
	});
});
