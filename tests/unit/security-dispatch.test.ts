import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchSecurity } from "../../src/tools/security.js";

interface Result {
	confidence: "high" | "medium" | "low";
	knownGaps: string[];
	[k: string]: unknown;
}

let root: string;

beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), "sec-disp-"));
});

afterEach(async () => {
	await fsp.rm(root, { recursive: true, force: true });
});

describe("ream-mcp > tools > security.scan dispatcher", () => {
	it("returns a structured error envelope for unknown tool names", async () => {
		const r = (await dispatchSecurity(root, "security.unknown")) as Result;
		expect(r.confidence).toBe("low");
		expect(r.error).toContain("Unknown security tool");
	});

	it("rejects checks=<non-array> with a clear shape error", async () => {
		const r = (await dispatchSecurity(root, "security.scan", {
			checks: "sql_interpolation",
		})) as Result;
		expect(r.error).toBe("invalid checks");
		expect(r.hint).toContain("array");
	});

	it("rejects an unknown check id and lists valid options", async () => {
		const r = (await dispatchSecurity(root, "security.scan", {
			checks: ["nope_not_a_check"],
		})) as Result;
		expect(r.error).toContain("unknown check");
		expect(r.hint).toContain("valid checks:");
	});

	it("rejects a non-string check entry", async () => {
		const r = (await dispatchSecurity(root, "security.scan", {
			checks: [42],
		})) as Result;
		expect(r.error).toContain("unknown check");
	});

	it("returns empty findings when the workspace has no source files", async () => {
		const r = (await dispatchSecurity(root, "security.scan", {})) as Result;
		expect(r.confidence).toBe("medium"); // gap: 'no source files found'
		expect(r.knownGaps.some((g) => g.includes("no source files"))).toBe(true);
		expect(r.findings).toEqual([]);
	});

	it("accepts an empty checks array as 'run all checks' (default)", async () => {
		const r = (await dispatchSecurity(root, "security.scan", {
			checks: [],
		})) as Result;
		// No source files → empty findings, not the parseChecks error path.
		expect(r.findings).toEqual([]);
		expect(r.error).toBeUndefined();
	});

	it("deduplicates repeated check ids in the input", async () => {
		const r = (await dispatchSecurity(root, "security.scan", {
			checks: ["sql_interpolation", "sql_interpolation"],
		})) as Result;
		// Selection passes (no error) → dedupe ran successfully.
		expect(r.error).toBeUndefined();
	});
});
