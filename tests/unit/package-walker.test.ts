/**
 * `walkWorkspacePackages` unit tests — Story 33.5.
 *
 * Builds tmp workspace layouts to confirm the walker:
 *   - returns one row per `package.json` with a resolvable entry,
 *   - sorts the result by package `name`,
 *   - skips `node_modules/`, hidden directories, and packages
 *     whose entry can't be resolved.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { walkWorkspacePackages } from "../../src/util/package-walker.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pkg-walker-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writePkg(
	dir: string,
	pkg: Record<string, unknown>,
	entryRel?: string,
): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
	if (entryRel) {
		const entryPath = join(dir, entryRel);
		mkdirSync(join(entryPath, ".."), { recursive: true });
		writeFileSync(entryPath, "export const x = 1;\n");
	}
}

describe("walkWorkspacePackages", () => {
	it("returns two packages sorted by name", () => {
		writePkg(join(root, "packages", "zeta"), { name: "zeta" }, "src/index.ts");
		writePkg(
			join(root, "packages", "alpha"),
			{ name: "alpha" },
			"src/index.ts",
		);

		const found = walkWorkspacePackages(root);
		expect(found.map((p) => p.name)).toEqual(["alpha", "zeta"]);
		expect(found[0].mainEntry.endsWith("alpha/src/index.ts")).toBe(true);
	});

	it("skips node_modules even when nested package.jsons live there", () => {
		writePkg(
			join(root, "node_modules", "ghost"),
			{ name: "ghost" },
			"src/index.ts",
		);
		writePkg(join(root, "packages", "real"), { name: "real" }, "src/index.ts");

		const found = walkWorkspacePackages(root);
		expect(found.map((p) => p.name)).toEqual(["real"]);
	});

	it("skips a package whose entry cannot be resolved", () => {
		writePkg(join(root, "packages", "no-entry"), { name: "no-entry" });
		writePkg(join(root, "packages", "good"), { name: "good" }, "src/index.ts");
		const found = walkWorkspacePackages(root);
		expect(found.map((p) => p.name)).toEqual(["good"]);
	});

	it("honors `main` over the conventional `src/index.ts`", () => {
		writePkg(
			join(root, "packages", "custom"),
			{ name: "custom", main: "lib/entry.ts" },
			"lib/entry.ts",
		);
		const found = walkWorkspacePackages(root);
		expect(found[0].name).toBe("custom");
		expect(found[0].mainEntry.endsWith("lib/entry.ts")).toBe(true);
	});

	it("does not recurse INTO a package once `package.json` is found", () => {
		// A nested `package.json` under a parent `package.json` is
		// invisible — the walker stops descending at the outer one.
		writePkg(join(root, "outer"), { name: "outer" }, "src/index.ts");
		writePkg(join(root, "outer", "nested"), { name: "nested" }, "src/index.ts");
		const found = walkWorkspacePackages(root);
		expect(found.map((p) => p.name)).toEqual(["outer"]);
	});
});
