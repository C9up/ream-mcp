/**
 * `quality.dep_graph` integration tests — Story 33.5.
 *
 * The introspect-app fixture carries a deliberate `cycle-a.ts` ↔
 * `cycle-b.ts` import cycle so the file-scope graph has a cycle to
 * surface. Package scope on a single-package fixture is acyclic.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { dispatchQuality } from "../../src/tools/quality.js";
import { _resetCache } from "../../src/util/ts-static-parser.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "introspect-app");

interface JsonGraph {
	nodes: Array<{ id: string; kind: "package" | "file" }>;
	edges: Array<{ from: string; to: string; weight: number }>;
	cycles: string[][];
	confidence: "high" | "medium" | "low";
	knownGaps: string[];
}

interface DotGraph {
	graph: string;
	cycles: string[][];
	confidence: "high" | "medium" | "low";
	knownGaps: string[];
}

beforeAll(() => {
	_resetCache();
});

describe("quality > dep_graph", () => {
	it("surfaces the cycle-a / cycle-b cycle at file scope", () => {
		const result = dispatchQuality(FIXTURE, "quality.dep_graph", {
			scope: "file",
		}) as JsonGraph;
		expect(result.confidence).toBe("high");
		const cycle = result.cycles.find(
			(c) =>
				c.some((id) => id.endsWith("cycle-a.ts")) &&
				c.some((id) => id.endsWith("cycle-b.ts")),
		);
		expect(cycle).toBeDefined();
		// File-scope nodes include the cycle pair.
		expect(
			result.nodes.some(
				(n) => n.id.endsWith("cycle-a.ts") && n.kind === "file",
			),
		).toBe(true);
	});

	it("returns Graphviz dot when format=dot", () => {
		const result = dispatchQuality(FIXTURE, "quality.dep_graph", {
			format: "dot",
			scope: "file",
		}) as DotGraph;
		expect(result.graph.startsWith("digraph")).toBe(true);
		// Cycle edges are styled red.
		expect(result.graph).toContain('color="red"');
	});

	it("rejects an unknown format with a structured error", () => {
		const result = dispatchQuality(FIXTURE, "quality.dep_graph", {
			format: "yaml",
		}) as { error: string; hint: string; confidence: string };
		expect(result.error).toContain("invalid format");
		expect(result.confidence).toBe("low");
	});

	it("rejects an unknown scope with a structured error", () => {
		const result = dispatchQuality(FIXTURE, "quality.dep_graph", {
			scope: "module",
		}) as { error: string; hint: string; confidence: string };
		expect(result.error).toContain("invalid scope");
		expect(result.confidence).toBe("low");
	});

	it("returns json by default", () => {
		const result = dispatchQuality(FIXTURE, "quality.dep_graph") as JsonGraph;
		expect(Array.isArray(result.nodes)).toBe(true);
		expect(Array.isArray(result.edges)).toBe(true);
		expect(Array.isArray(result.cycles)).toBe(true);
	});
});
