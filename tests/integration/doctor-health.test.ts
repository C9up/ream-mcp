/**
 * `doctor.health` integration test — Story 33.8.
 */

import { describe, expect, it } from "vitest";

import { dispatchDoctor } from "../../src/tools/doctor.js";

interface HealthShape {
	nodeVersion: string;
	rustVersion: string | null;
	napiBinariesBuilt: Array<{ package: string; binary: string }>;
	missingBinaries: Array<{ package: string; expected: string; hint: string }>;
	workspaceClean: boolean;
	confidence: string;
	knownGaps: string[];
}

describe("doctor.health", () => {
	it("reports `process.version` as nodeVersion", async () => {
		const result = (await dispatchDoctor(
			"/tmp",
			"doctor.health",
			{},
		)) as HealthShape;
		expect(result.nodeVersion).toBe(process.version);
	});

	it("returns rustVersion as a string or null (never throws on missing toolchain)", async () => {
		const result = (await dispatchDoctor(
			"/tmp",
			"doctor.health",
			{},
		)) as HealthShape;
		expect(
			result.rustVersion === null || typeof result.rustVersion === "string",
		).toBe(true);
	});

	it("returns the standard wire-shape envelope", async () => {
		const result = (await dispatchDoctor(
			"/tmp",
			"doctor.health",
			{},
		)) as HealthShape;
		expect(Array.isArray(result.napiBinariesBuilt)).toBe(true);
		expect(Array.isArray(result.missingBinaries)).toBe(true);
		expect(typeof result.workspaceClean).toBe("boolean");
		expect(["high", "medium", "low"]).toContain(result.confidence);
	});
});
