/**
 * `quality.duplicates` integration tests — Story 33.5.
 *
 * Drives the dispatcher against the introspect-app fixture which
 * carries a hand-crafted duplicate pair (`app/billing/Helper.ts` ↔
 * `app/orders/SameHelper.ts`) — same body, different identifiers,
 * so the rolling-hash detector must anonymize names to match them.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { dispatchQuality } from "../../src/tools/quality.js";
import { _resetCache } from "../../src/util/ts-static-parser.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "introspect-app");

interface DupShape {
	duplicates: Array<{
		files: Array<{ path: string; lines: [number, number] }>;
		tokens: number;
		similarity: number;
	}>;
	confidence: "high" | "medium" | "low";
	knownGaps: string[];
}

beforeAll(() => {
	_resetCache();
});

describe("quality > duplicates", () => {
	it("detects the Helper / SameHelper pair across identifier rename", () => {
		const result = dispatchQuality(FIXTURE, "quality.duplicates", {
			minTokens: 20,
			minLines: 3,
		}) as DupShape;

		const pair = result.duplicates.find(
			(d) =>
				d.files.some((f) => f.path === "app/billing/Helper.ts") &&
				d.files.some((f) => f.path === "app/orders/SameHelper.ts"),
		);
		expect(pair).toBeDefined();
		expect(pair?.similarity).toBe(1.0);
		// After greedy extension, `tokens` reflects the actual matched
		// run length (the Helper bodies extend to ~31 tokens), not
		// the minTokens floor of 20.
		expect(pair?.tokens).toBeGreaterThan(25);
		const billing = pair?.files.find((f) => f.path === "app/billing/Helper.ts");
		const orders = pair?.files.find(
			(f) => f.path === "app/orders/SameHelper.ts",
		);
		expect(billing?.lines[0]).toBeLessThanOrEqual(5);
		expect(orders?.lines[0]).toBeLessThanOrEqual(5);
	});

	it("returns an empty list when minTokens is set above the file size", () => {
		const result = dispatchQuality(FIXTURE, "quality.duplicates", {
			minTokens: 1000,
		}) as DupShape;
		expect(result.duplicates).toEqual([]);
	});

	it("rejects invalid minTokens with a structured error", () => {
		const result = dispatchQuality(FIXTURE, "quality.duplicates", {
			minTokens: 0,
		}) as { error: string; hint: string; confidence: string };
		expect(result.error).toContain("minTokens");
		expect(result.confidence).toBe("low");
	});

	it("rejects invalid minLines with a structured error", () => {
		const result = dispatchQuality(FIXTURE, "quality.duplicates", {
			minLines: -1,
		}) as { error: string; hint: string; confidence: string };
		expect(result.error).toContain("minLines");
		expect(result.confidence).toBe("low");
	});
});
