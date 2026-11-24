import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchSecurity, rawOutputLines } from "../../src/tools/security.js";

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

	it("refuses reflect_metadata_missing, which Ream has no use for", async () => {
		// @c9up/ream imports reflect-metadata itself, before any of its
		// decorators can run, so an application has nothing to add.
		const r = (await dispatchSecurity(root, "security.scan", {
			checks: ["reflect_metadata_missing"],
		})) as Result;
		expect(r.error).toBe("unknown check: reflect_metadata_missing");
	});

	it("scans a Ream application's root when it has no src/ directory", async () => {
		await fsp.writeFile(
			path.join(root, "package.json"),
			JSON.stringify({ name: "app", private: true }),
		);
		await fsp.mkdir(path.join(root, "start"));
		await fsp.writeFile(
			path.join(root, "start", "routes.ts"),
			"import router from '@c9up/ream/services/router';\nrouter.post('/x', async () => {});\n",
		);
		const r = (await dispatchSecurity(root, "security.scan", {})) as Result;
		expect(r.findings).toEqual([
			expect.objectContaining({
				check: "missing_guard_on_mutation_route",
				file: "start/routes.ts",
				line: 2,
			}),
		]);
	});

	it("passes what a check could not decide on as knownGaps", async () => {
		await fsp.mkdir(path.join(root, "src"));
		await fsp.writeFile(
			path.join(root, "src", "routes.ts"),
			"import router from '@c9up/ream/services/router';\nimport { C } from 'elsewhere';\nrouter.post('/x', [C, 'store']);\n",
		);
		const r = (await dispatchSecurity(root, "security.scan", {})) as Result;
		expect(r.findings).toEqual([]);
		expect(r.confidence).toBe("medium");
		expect(r.knownGaps).toEqual([
			expect.stringContaining(
				"src/routes.ts:3: not decided (cannot resolve 'elsewhere')",
			),
		]);
	});
});

describe("ream-mcp > tools > security.scan > inker raw output", () => {
	it("finds every line that opens a raw {{{ }}} output", () => {
		const template = [
			"<h1>{{ post.title }}</h1>",
			"<div>{{{ post.body }}}</div>",
			"Literal: \\{{{ not output }}}",
			"{{-- a comment that mentions {{{ raw }}}",
			"     over two lines {{{ x }}} --}}",
			"{{{ await $slots.main() }}}",
		].join("\n");
		expect(rawOutputLines(template)).toEqual([2, 6]);
	});
});
