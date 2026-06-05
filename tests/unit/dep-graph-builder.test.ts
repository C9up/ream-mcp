/**
 * `buildDepGraph` + `toDot` unit tests — Story 33.5.
 *
 * Use real on-disk tmp fixtures (not in-memory) because the graph
 * builder calls `existsSync` to resolve module specifiers — the
 * in-memory ts-morph FS isn't visible to `node:fs`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildDepGraph, toDot } from "../../src/util/dep-graph-builder.js";
import type { WorkspacePackage } from "../../src/util/package-walker.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "dep-graph-"));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

function setupProject(): Project {
	const tsConfigPath = join(tmpRoot, "tsconfig.json");
	writeFileSync(
		tsConfigPath,
		JSON.stringify({
			compilerOptions: { target: "ES2022", module: "NodeNext" },
		}),
	);
	return new Project({
		tsConfigFilePath: tsConfigPath,
		skipFileDependencyResolution: true,
	});
}

describe("buildDepGraph", () => {
	it("detects a 2-node cycle at file scope", () => {
		mkdirSync(join(tmpRoot, "src"));
		writeFileSync(
			join(tmpRoot, "src", "a.ts"),
			'import { b } from "./b.js";\nexport const a = () => b();\n',
		);
		writeFileSync(
			join(tmpRoot, "src", "b.ts"),
			'import { a } from "./a.js";\nexport const b = () => a();\n',
		);
		const project = setupProject();
		project.addSourceFilesAtPaths(join(tmpRoot, "src", "*.ts"));

		const graph = buildDepGraph(project, tmpRoot, "file", []);
		expect(graph.nodes.length).toBe(2);
		expect(graph.cycles.length).toBe(1);
		expect(graph.cycles[0].sort()).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("does NOT include external bare specifiers as nodes", () => {
		mkdirSync(join(tmpRoot, "src"));
		writeFileSync(
			join(tmpRoot, "src", "x.ts"),
			'import _ from "lodash";\nimport { mkdirSync } from "node:fs";\nexport const f = () => _;\n',
		);
		const project = setupProject();
		project.addSourceFilesAtPaths(join(tmpRoot, "src", "*.ts"));

		const graph = buildDepGraph(project, tmpRoot, "file", []);
		const ids = graph.nodes.map((n) => n.id);
		expect(ids).toContain("src/x.ts");
		expect(ids).not.toContain("lodash");
		expect(ids).not.toContain("node:fs");
	});

	it("rotates cycles to lex-smallest first element", () => {
		mkdirSync(join(tmpRoot, "src"));
		writeFileSync(
			join(tmpRoot, "src", "z.ts"),
			'import { a } from "./a.js";\nexport const z = () => a();\n',
		);
		writeFileSync(
			join(tmpRoot, "src", "a.ts"),
			'import { z } from "./z.js";\nexport const a = () => z();\n',
		);
		const project = setupProject();
		project.addSourceFilesAtPaths(join(tmpRoot, "src", "*.ts"));
		const graph = buildDepGraph(project, tmpRoot, "file", []);
		expect(graph.cycles[0][0]).toBe("src/a.ts");
	});

	it("resolves workspace sub-path imports to .tsx files (UI packages)", () => {
		// pkg-ui exposes `@scope/pkg-ui/Button` as a .tsx file. The relative-
		// import branch handled .tsx; the workspace sub-path branch
		// previously only handled .ts and silently dropped this edge.
		mkdirSync(join(tmpRoot, "pkg-ui", "src"), { recursive: true });
		writeFileSync(
			join(tmpRoot, "pkg-ui", "package.json"),
			JSON.stringify({ name: "@scope/pkg-ui", main: "src/index.ts" }),
		);
		writeFileSync(
			join(tmpRoot, "pkg-ui", "src", "index.ts"),
			"export const ui = 1;\n",
		);
		writeFileSync(
			join(tmpRoot, "pkg-ui", "src", "Button.tsx"),
			"export const Button = () => null;\n",
		);
		mkdirSync(join(tmpRoot, "consumer", "src"), { recursive: true });
		writeFileSync(
			join(tmpRoot, "consumer", "package.json"),
			JSON.stringify({ name: "consumer", main: "src/index.ts" }),
		);
		writeFileSync(
			join(tmpRoot, "consumer", "src", "index.ts"),
			'import { Button } from "@scope/pkg-ui/Button";\nexport const x = Button;\n',
		);
		const project = setupProject();
		project.addSourceFilesAtPaths(join(tmpRoot, "**", "*.{ts,tsx}"));
		const pkgs: WorkspacePackage[] = [
			{
				name: "@scope/pkg-ui",
				dir: join(tmpRoot, "pkg-ui"),
				mainEntry: join(tmpRoot, "pkg-ui", "src", "index.ts"),
			},
			{
				name: "consumer",
				dir: join(tmpRoot, "consumer"),
				mainEntry: join(tmpRoot, "consumer", "src", "index.ts"),
			},
		];
		const graph = buildDepGraph(project, tmpRoot, "package", pkgs);
		expect(graph.edges).toContainEqual({
			from: "consumer",
			to: "@scope/pkg-ui",
			weight: 1,
		});
	});

	it("resolves workspace sub-path imports written as `.js` (NodeNext convention)", () => {
		// `import "@pkg/foo.js"` must source-resolve to `@pkg/src/foo.ts`
		// — the relative-import branch already does this swap; the
		// workspace branch previously did not.
		mkdirSync(join(tmpRoot, "pkg", "src"), { recursive: true });
		writeFileSync(
			join(tmpRoot, "pkg", "package.json"),
			JSON.stringify({ name: "pkg", main: "src/index.ts" }),
		);
		writeFileSync(join(tmpRoot, "pkg", "src", "index.ts"), "export {};\n");
		writeFileSync(
			join(tmpRoot, "pkg", "src", "foo.ts"),
			"export const foo = 1;\n",
		);
		mkdirSync(join(tmpRoot, "cons", "src"), { recursive: true });
		writeFileSync(
			join(tmpRoot, "cons", "package.json"),
			JSON.stringify({ name: "cons", main: "src/index.ts" }),
		);
		writeFileSync(
			join(tmpRoot, "cons", "src", "index.ts"),
			'import { foo } from "pkg/foo.js";\nexport const x = foo;\n',
		);
		const project = setupProject();
		project.addSourceFilesAtPaths(join(tmpRoot, "**", "*.ts"));
		const pkgs: WorkspacePackage[] = [
			{
				name: "pkg",
				dir: join(tmpRoot, "pkg"),
				mainEntry: join(tmpRoot, "pkg", "src", "index.ts"),
			},
			{
				name: "cons",
				dir: join(tmpRoot, "cons"),
				mainEntry: join(tmpRoot, "cons", "src", "index.ts"),
			},
		];
		const graph = buildDepGraph(project, tmpRoot, "package", pkgs);
		expect(graph.edges).toContainEqual({
			from: "cons",
			to: "pkg",
			weight: 1,
		});
	});

	it("folds intra-package imports into a single package node (no self-loop)", () => {
		mkdirSync(join(tmpRoot, "src"));
		writeFileSync(
			join(tmpRoot, "package.json"),
			JSON.stringify({ name: "pkg-x", main: "src/index.ts" }),
		);
		writeFileSync(
			join(tmpRoot, "src", "index.ts"),
			'import "./helper.js";\nexport const x = 1;\n',
		);
		writeFileSync(
			join(tmpRoot, "src", "helper.ts"),
			"export const helper = () => 0;\n",
		);
		const project = setupProject();
		project.addSourceFilesAtPaths(join(tmpRoot, "src", "*.ts"));
		const pkg: WorkspacePackage = {
			name: "pkg-x",
			dir: tmpRoot,
			mainEntry: join(tmpRoot, "src", "index.ts"),
		};
		const graph = buildDepGraph(project, tmpRoot, "package", [pkg]);
		expect(graph.nodes.map((n) => n.id)).toEqual(["pkg-x"]);
		expect(graph.edges).toEqual([]);
		expect(graph.cycles).toEqual([]);
	});
});

describe("toDot", () => {
	it("renders a digraph with red edges on cycles", () => {
		const dot = toDot({
			nodes: [
				{ id: "a", kind: "file" },
				{ id: "b", kind: "file" },
			],
			edges: [
				{ from: "a", to: "b", weight: 1 },
				{ from: "b", to: "a", weight: 1 },
			],
			cycles: [["a", "b"]],
		});
		expect(dot.startsWith("digraph deps {")).toBe(true);
		expect(dot).toContain('"a" -> "b" [color="red"]');
		expect(dot).toContain('"b" -> "a" [color="red"]');
		expect(dot.trimEnd().endsWith("}")).toBe(true);
	});

	it("emits acyclic edges without a color attribute", () => {
		const dot = toDot({
			nodes: [
				{ id: "a", kind: "file" },
				{ id: "b", kind: "file" },
			],
			edges: [{ from: "a", to: "b", weight: 1 }],
			cycles: [],
		});
		expect(dot).toContain('"a" -> "b";');
		expect(dot).not.toContain("red");
	});
});
