/**
 * Verifies the published tarball shape for @c9up/ream-mcp.
 *
 * publishConfig overrides package.json fields at publish time, so a wrong
 * publishConfig is invisible to workspace-mode pnpm installs. The first
 * execution path that sees the published shape is `npm install` in a
 * consumer project — by which time the broken tarball is already on the
 * registry. This test catches that regression locally by packing into a
 * tmp dir, parsing the tarball's package.json, and asserting every
 * advertised export + bin entry resolves to a file inside the tarball.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type ExportEntry = { import: string; types: string };
type PackJson = {
	exports: Record<string, ExportEntry>;
	bin: Record<string, string>;
};

function isExportEntry(value: unknown): value is ExportEntry {
	if (value === null || typeof value !== "object") return false;
	if (!("import" in value) || !("types" in value)) return false;
	return typeof value.import === "string" && typeof value.types === "string";
}

function isExportsMap(value: unknown): value is Record<string, ExportEntry> {
	if (value === null || typeof value !== "object") return false;
	for (const key of Object.keys(value)) {
		const entry: unknown = Reflect.get(value, key);
		if (!isExportEntry(entry)) return false;
	}
	return true;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (value === null || typeof value !== "object") return false;
	for (const key of Object.keys(value)) {
		const entry: unknown = Reflect.get(value, key);
		if (typeof entry !== "string") return false;
	}
	return true;
}

function isPackJson(value: unknown): value is PackJson {
	if (value === null || typeof value !== "object") return false;
	if (!("exports" in value) || !("bin" in value)) return false;
	return isExportsMap(value.exports) && isStringRecord(value.bin);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..", "..");

describe("@c9up/ream-mcp published shape", () => {
	let tmpDir = "";
	let tarballPath = "";

	beforeAll(() => {
		// AC7 — fail loudly when build hasn't run; never skip.
		const distEntry = path.join(PKG_ROOT, "dist/index.js");
		const napiLoader = path.join(PKG_ROOT, "index.js");
		if (!existsSync(distEntry) || !existsSync(napiLoader)) {
			throw new Error(
				"Run `pnpm --filter @c9up/ream-mcp build` before this test — " +
					"published-shape verification requires the built artifacts.",
			);
		}

		tmpDir = mkdtempSync(path.join(tmpdir(), "ream-mcp-pack-"));
		const stdout = execFileSync(
			"pnpm",
			["pack", "--pack-destination", tmpDir],
			{ cwd: PKG_ROOT, encoding: "utf8" },
		);
		const lastLine = stdout
			.trim()
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.pop();
		if (lastLine && existsSync(lastLine)) {
			tarballPath = lastLine;
		} else {
			throw new Error(
				`pnpm pack did not produce a discoverable tarball; stdout was:\n${stdout}`,
			);
		}
	});

	afterAll(() => {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	it("exports the 3 publishConfig sub-paths and every advertised target lands in the tarball", () => {
		const pkgJsonRaw = execFileSync(
			"tar",
			["-xzOf", tarballPath, "package/package.json"],
			{ encoding: "utf8" },
		);
		const parsed: unknown = JSON.parse(pkgJsonRaw);
		if (!isPackJson(parsed)) {
			throw new Error("tarball package.json shape unexpected");
		}

		// AC4 — three sub-paths present (import + types shape validated by isPackJson above)
		expect(Object.keys(parsed.exports).sort()).toEqual([
			".",
			"./napi",
			"./util/project-root",
		]);

		// AC5 — every advertised import + types target lives in the tarball
		const tarList = execFileSync("tar", ["-tzf", tarballPath], {
			encoding: "utf8",
		})
			.split("\n")
			.filter(Boolean);
		const inTarball = new Set(tarList);
		for (const entry of Object.values(parsed.exports)) {
			const importTarget = entry.import.replace(/^\.\//, "package/");
			const typesTarget = entry.types.replace(/^\.\//, "package/");
			expect(inTarball.has(importTarget), importTarget).toBe(true);
			expect(inTarball.has(typesTarget), typesTarget).toBe(true);
		}

		// AC6 — bin entries resolve
		for (const binTarget of Object.values(parsed.bin)) {
			const fullPath = `package/${binTarget.replace(/^\.?\/?/, "")}`;
			expect(inTarball.has(fullPath), fullPath).toBe(true);
		}
	});
});
