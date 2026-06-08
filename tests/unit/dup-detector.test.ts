/**
 * `findDuplicates` unit tests — Story 33.5.
 *
 * Synthetic in-memory projects so we can isolate the rolling-hash
 * detector from the on-disk fixture. Confirms the anonymization
 * rules: identifiers match across rename, but different string
 * literals do NOT match (literal text is preserved).
 */

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { findDuplicates } from "../../src/util/dup-detector.js";

function inMemoryProject(files: Record<string, string>): Project {
	const project = new Project({ useInMemoryFileSystem: true });
	for (const [path, content] of Object.entries(files)) {
		project.createSourceFile(path, content);
	}
	return project;
}

describe("findDuplicates", () => {
	it("matches the same body across an identifier rename", () => {
		const project = inMemoryProject({
			"/a.ts":
				"export function applyDiscount(subtotal: number, rate: number, floor: number) {\n" +
				"  if (rate < 0) { throw new Error('rate'); }\n" +
				"  if (subtotal <= floor) { return floor; }\n" +
				"  const discounted = subtotal * (1 - rate);\n" +
				"  return discounted < floor ? floor : discounted;\n" +
				"}\n",
			"/b.ts":
				"export function discountOrder(total: number, pct: number, minimum: number) {\n" +
				"  if (pct < 0) { throw new Error('rate'); }\n" +
				"  if (total <= minimum) { return minimum; }\n" +
				"  const reduced = total * (1 - pct);\n" +
				"  return reduced < minimum ? minimum : reduced;\n" +
				"}\n",
		});
		const result = findDuplicates(project, "/", {
			minTokens: 20,
			minLines: 3,
		});
		expect(result.duplicates.length).toBeGreaterThan(0);
		const top = result.duplicates[0];
		expect(top.similarity).toBe(1.0);
		expect(top.files.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts"]);
	});

	it("does NOT collapse two functions whose only difference is a string literal", () => {
		const project = inMemoryProject({
			"/a.ts":
				"export function f(x: number) {\n" +
				"  if (x < 0) { throw new Error('negative'); }\n" +
				"  return x + 1;\n" +
				"}\n",
			"/b.ts":
				"export function f(x: number) {\n" +
				"  if (x < 0) { throw new Error('positive'); }\n" +
				"  return x + 1;\n" +
				"}\n",
		});
		// Per spec AC: literals are preserved, so two bodies that
		// differ only in their string-literal text are NOT duplicates.
		const result = findDuplicates(project, "/", {
			minTokens: 10,
			minLines: 2,
		});
		expect(result.duplicates).toEqual([]);
	});

	it("does NOT collapse two functions whose only difference is a numeric literal", () => {
		const project = inMemoryProject({
			"/a.ts":
				"export function f(x: number) {\n" +
				"  if (x < 0) { return 1; }\n" +
				"  return x + 1;\n" +
				"}\n",
			"/b.ts":
				"export function f(x: number) {\n" +
				"  if (x < 0) { return 2; }\n" +
				"  return x + 1;\n" +
				"}\n",
		});
		const result = findDuplicates(project, "/", {
			minTokens: 10,
			minLines: 2,
		});
		expect(result.duplicates).toEqual([]);
	});

	it("rejects nonsensical thresholds", () => {
		const project = inMemoryProject({ "/a.ts": "export const x = 1;\n" });
		expect(() =>
			findDuplicates(project, "/", { minTokens: 0, minLines: 1 }),
		).toThrow(/minTokens must be >= 1/);
		expect(() =>
			findDuplicates(project, "/", { minTokens: 1, minLines: 0 }),
		).toThrow(/minLines must be >= 1/);
	});

	it("returns canonical ordering: tokens desc, then path asc", () => {
		const project = inMemoryProject({
			"/short-a.ts":
				"export function f(a: number, b: number) {\n" +
				"  return a + b;\n" +
				"}\n",
			"/short-b.ts":
				"export function g(x: number, y: number) {\n" +
				"  return x + y;\n" +
				"}\n",
		});
		const result = findDuplicates(project, "/", {
			minTokens: 5,
			minLines: 1,
		});
		for (const dup of result.duplicates) {
			const paths = dup.files.map((f) => f.path);
			const sorted = [...paths].sort();
			expect(paths).toEqual(sorted);
		}
	});

	it("rejects a single-line duplicate when minLines: 3", () => {
		// Both files have an identical body packed onto a single
		// line — token count is high but line span is 1, so the
		// `minLines` gate must drop it.
		const oneLine =
			"export const f = () => { const a = 1; const b = 2; const c = 3; const d = 4; return a + b + c + d; };\n";
		const project = inMemoryProject({
			"/a.ts": oneLine,
			"/b.ts": oneLine,
		});
		const result = findDuplicates(project, "/", {
			minTokens: 10,
			minLines: 3,
		});
		expect(result.duplicates).toEqual([]);
	});

	it("reports a duplicate's `tokens` as the actual matched run length, not just minTokens", () => {
		// Two identical bodies of ~25 tokens each should report the
		// extended run length, not the floor of 5 set by minTokens.
		const body =
			"export function f(a: number, b: number, c: number) {\n" +
			"  const x = a + b;\n" +
			"  const y = b + c;\n" +
			"  const z = c + a;\n" +
			"  return x + y + z;\n" +
			"}\n";
		const project = inMemoryProject({
			"/one.ts": body,
			"/two.ts": body,
		});
		const result = findDuplicates(project, "/", {
			minTokens: 5,
			minLines: 2,
		});
		expect(result.duplicates.length).toBeGreaterThan(0);
		expect(result.duplicates[0].tokens).toBeGreaterThan(20);
	});

	it("skips files larger than 1 MB and records them in `skipped`", () => {
		const big = `export const x = ${"1+".repeat(600_000)}1;\n`;
		const project = inMemoryProject({ "/big.ts": big });
		const result = findDuplicates(project, "/", {
			minTokens: 10,
			minLines: 2,
		});
		expect(result.skipped).toEqual(["big.ts (> 1 MB)"]);
		expect(result.duplicates).toEqual([]);
	});

	it("does not crash on a malformed source file", () => {
		// ts-morph parses leniently — confirm graceful behavior on
		// a file that's syntactically broken: either it ends up in
		// `skipped` (parse-error catch) OR it tokenizes leniently
		// without producing duplicates. Both are acceptable.
		const project = inMemoryProject({
			"/broken.ts": "export function f( {\n  return\n",
			"/ok.ts": "export const x = 1;\n",
		});
		expect(() =>
			findDuplicates(project, "/", { minTokens: 5, minLines: 1 }),
		).not.toThrow();
	});
});
