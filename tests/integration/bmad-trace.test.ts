/**
 * `bmad.trace` integration test — Story 33.8.
 *
 * Builds a tmpdir scratch with epics.md + a code file mentioning
 * a requirement id and asserts the trace finds the file.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchBmad } from "../../src/tools/bmad.js";

interface TraceShape {
	requirementId: string;
	epics: Array<{ id: string; title: string }>;
	stories: Array<{ id: string; title: string; status: string }>;
	codeFiles: Array<{ path: string; line: number }>;
	testFiles: Array<{ path: string; line: number }>;
	confidence: string;
	knownGaps: string[];
}

interface ErrorShape {
	error: string;
	hint: string;
	confidence: string;
	knownGaps: string[];
}

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "bmad-trace-"));
	mkdirSync(join(scratch, "_bmad-output", "implementation-artifacts"), {
		recursive: true,
	});
	mkdirSync(join(scratch, "_bmad-output", "planning-artifacts"));
	writeFileSync(
		join(scratch, "package.json"),
		JSON.stringify({ name: "scratch", version: "0.0.0", private: true }),
	);
	mkdirSync(join(scratch, "src"));
	writeFileSync(
		join(scratch, "_bmad-output", "planning-artifacts", "epics.md"),
		[
			"## Epic 5: Trace target",
			"### Story 5.1: First (implements FR-7)",
			"body",
		].join("\n"),
	);
	writeFileSync(
		join(scratch, "src", "feature.ts"),
		"// implements FR-7\nexport const x = 1;\n",
	);
	writeFileSync(
		join(scratch, "src", "feature.test.ts"),
		"// covers FR-7\ntest('x', () => {});\n",
	);
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("bmad.trace", () => {
	it("locates the requirement in epics.md and a project file", async () => {
		const result = (await dispatchBmad(scratch, "bmad.trace", {
			requirement_id: "FR-7",
		})) as TraceShape;
		expect(result.requirementId).toBe("FR-7");
		expect(result.stories.map((s) => s.id)).toContain("5.1");
		const codePaths = result.codeFiles.map((f) => f.path);
		expect(codePaths).toContain("src/feature.ts");
		const testPaths = result.testFiles.map((f) => f.path);
		expect(testPaths).toContain("src/feature.test.ts");
	});

	it("does not match a substring requirement id (FR-7 vs FR-70)", async () => {
		writeFileSync(
			join(scratch, "src", "other.ts"),
			"// references FR-70 only\nexport const y = 2;\n",
		);
		const result = (await dispatchBmad(scratch, "bmad.trace", {
			requirement_id: "FR-7",
		})) as TraceShape;
		const codePaths = result.codeFiles.map((f) => f.path);
		expect(codePaths).not.toContain("src/other.ts");
	});

	it("rejects an empty requirement_id with a structured error", async () => {
		const result = (await dispatchBmad(scratch, "bmad.trace", {
			requirement_id: "",
		})) as ErrorShape;
		expect(result.error).toContain("invalid");
	});
});
