/**
 * Unit tests for the 5-tier BMAD resolver — Story 33.8.
 *
 * Each test mounts a tmpdir scratch with one or more of the
 * candidate paths created, then asserts which tier wins.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveBmadRoot } from "../../src/util/bmad-resolver.js";

const SAVED_REAM_BMAD_ROOT = process.env.REAM_BMAD_ROOT;

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "bmad-resolver-"));
	delete process.env.REAM_BMAD_ROOT;
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
	if (SAVED_REAM_BMAD_ROOT === undefined) delete process.env.REAM_BMAD_ROOT;
	else process.env.REAM_BMAD_ROOT = SAVED_REAM_BMAD_ROOT;
});

describe("resolveBmadRoot", () => {
	it("returns null when no tier resolves", () => {
		expect(resolveBmadRoot(scratch)).toBeNull();
	});

	it("falls back to <root>/_bmad-output when nothing else exists", () => {
		mkdirSync(join(scratch, "_bmad-output"));
		const r = resolveBmadRoot(scratch);
		expect(r?.tier).toBe("default");
		expect(r?.root.endsWith("/_bmad-output")).toBe(true);
	});

	it("prefers REAM_BMAD_ROOT over the default tier", () => {
		const customDir = join(scratch, "custom-bmad");
		mkdirSync(customDir);
		mkdirSync(join(scratch, "_bmad-output"));
		process.env.REAM_BMAD_ROOT = customDir;
		const r = resolveBmadRoot(scratch);
		expect(r?.tier).toBe("env");
		expect(r?.root).toBe(customDir.replace(/\\/g, "/"));
	});

	it("prefers reamrc.ts `bmadRoot` field over REAM_BMAD_ROOT", () => {
		const reamrcDir = join(scratch, "via-reamrc");
		mkdirSync(reamrcDir);
		mkdirSync(join(scratch, "custom-bmad"));
		mkdirSync(join(scratch, "_bmad-output"));
		writeFileSync(
			join(scratch, "reamrc.ts"),
			`export default {
				bmadRoot: "via-reamrc",
			};`,
		);
		process.env.REAM_BMAD_ROOT = join(scratch, "custom-bmad");
		const r = resolveBmadRoot(scratch);
		expect(r?.tier).toBe("reamrc");
		expect(r?.root.endsWith("/via-reamrc")).toBe(true);
	});

	it("falls through to legacy and flat tiers when default is missing", () => {
		mkdirSync(join(scratch, "ream-legacy"), { recursive: true });
		mkdirSync(join(scratch, "ream-legacy", "_bmad-output"));
		const r = resolveBmadRoot(scratch);
		expect(r?.tier).toBe("legacy");
	});

	it("records every tier in the candidates trace, even unresolved ones", () => {
		mkdirSync(join(scratch, "_bmad-output"));
		const r = resolveBmadRoot(scratch);
		expect(r).not.toBeNull();
		const tiers = r?.candidates.map((c) => c.tier);
		expect(tiers).toEqual(["reamrc", "env", "default", "legacy", "flat"]);
		const defaultCandidate = r?.candidates.find((c) => c.tier === "default");
		expect(defaultCandidate?.exists).toBe(true);
		const legacyCandidate = r?.candidates.find((c) => c.tier === "legacy");
		expect(legacyCandidate?.exists).toBe(false);
	});

	it("uses .bmad/ as the lowest-priority flat layout", () => {
		mkdirSync(join(scratch, ".bmad"));
		const r = resolveBmadRoot(scratch);
		expect(r?.tier).toBe("flat");
	});
});
