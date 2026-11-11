/**
 * Values the server did not produce — a package.json, a tool argument bag, a
 * project config, a JSON string from the native core — are checked, not
 * asserted. Each case below is an input an `as T` cast used to let through.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchGenerate } from "../../src/tools/generate.js";
import { dispatchIntrospect } from "../../src/tools/introspect.js";
import { parseIndexStats } from "../../src/util/index-stats.js";
import { walkWorkspacePackages } from "../../src/util/package-walker.js";
import { detectProjectRoot } from "../../src/util/project-root.js";

const INTROSPECT_APP = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"introspect-app",
);

let dir: string;
const savedRoot = process.env.REAM_PROJECT_ROOT;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ream-mcp-shapes-"));
	delete process.env.REAM_PROJECT_ROOT;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (savedRoot === undefined) delete process.env.REAM_PROJECT_ROOT;
	else process.env.REAM_PROJECT_ROOT = savedRoot;
});

describe("package.json of any shape", () => {
	it("walks past a package.json whose dependencies are not an object", () => {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ dependencies: { "@c9up/ream": "*" } }),
		);
		for (const [sub, body] of [
			["a", JSON.stringify({ dependencies: "@c9up/ream" })],
			["a/b", JSON.stringify({ devDependencies: ["@c9up/ream"] })],
			["a/b/c", "null"],
			["a/b/c/d", "[]"],
		] as const) {
			mkdirSync(join(dir, sub), { recursive: true });
			writeFileSync(join(dir, sub, "package.json"), body);
		}
		expect(detectProjectRoot(join(dir, "a", "b", "c", "d"))).toEqual({
			path: dir,
			source: "package.json",
		});
	});

	it("skips a workspace package whose package.json is not an object", () => {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
		);
		mkdirSync(join(dir, "packages", "good", "src"), { recursive: true });
		writeFileSync(
			join(dir, "packages", "good", "package.json"),
			JSON.stringify({
				name: "good",
				exports: { ".": { import: "./src/index.ts" } },
			}),
		);
		writeFileSync(join(dir, "packages", "good", "src", "index.ts"), "");
		mkdirSync(join(dir, "packages", "bad", "src"), { recursive: true });
		writeFileSync(join(dir, "packages", "bad", "package.json"), '"bad"');
		writeFileSync(join(dir, "packages", "bad", "src", "index.ts"), "");
		expect(walkWorkspacePackages(dir).map((p) => p.name)).toEqual(["good"]);
	});
});

describe("tool arguments of any shape", () => {
	it("refuses a module that is not a string instead of handing it to the CLI", async () => {
		const result = await dispatchGenerate(dir, "generate.migration", {
			name: "CreateOrders",
			module: 42,
		});
		expect(result).toMatchObject({ error: "invalid module" });
	});

	it("refuses a flag that is not a boolean", async () => {
		const result = await dispatchGenerate(dir, "generate.seeder", {
			name: "User",
			force: "yes",
		});
		expect(result).toMatchObject({ error: "invalid force" });
	});
});

describe("project config keys", () => {
	it("does not resolve inherited keys like `constructor` as config", () => {
		for (const key of ["app.constructor", "app.__proto__", "toString"]) {
			expect(
				dispatchIntrospect(INTROSPECT_APP, "get.config", { key }),
			).toMatchObject({ error: expect.stringContaining("not found") });
		}
	});
});

describe("native index statistics", () => {
	it("are checked field by field", () => {
		const good = {
			files_seen: 2,
			files_indexed: 1,
			files_unchanged: 0,
			files_skipped: 1,
			files_failed: 0,
			chunks_total: 3,
			elapsed_ms: 4,
		};
		expect(parseIndexStats(JSON.stringify(good))).toEqual(good);
		expect(() => parseIndexStats("[]")).toThrow(/unexpected/);
		expect(() =>
			parseIndexStats(JSON.stringify({ ...good, chunks_total: "3" })),
		).toThrow(/chunks_total/);
	});
});
