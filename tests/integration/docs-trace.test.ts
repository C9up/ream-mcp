/**
 * Integration test for `docs.trace` — `@implements` traceability
 * scanner. Uses a synthetic packages/ tree so we don't depend on the
 * real monorepo state (which would change between commits).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchDocs } from "../../src/tools/docs.js";

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "ream-mcp-trace-"));
	mkdirSync(join(workDir, "packages", "atlas", "src"), { recursive: true });
	mkdirSync(join(workDir, "packages", "atlas", "tests", "unit"), {
		recursive: true,
	});
	writeFileSync(
		join(workDir, "packages", "atlas", "src", "BaseEntity.ts"),
		"/** @implements FR37, FR38 */\nexport class BaseEntity {}\n",
	);
	writeFileSync(
		join(workDir, "packages", "atlas", "src", "Repository.ts"),
		"/**\n * @implements FR37\n */\nexport class Repository {}\n",
	);
	writeFileSync(
		join(workDir, "packages", "atlas", "tests", "unit", "entity.test.ts"),
		"/** @implements FR37 */\nimport { test } from 'vitest'\ntest('x', () => {})\n",
	);
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function plant(rel: string, body: string | Buffer): void {
	const path = join(workDir, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
}

function files(result: unknown, key: "implementations" | "tests"): string[] {
	if (typeof result !== "object" || result === null || !(key in result)) {
		throw new Error(`no ${key} in the trace result`);
	}
	const sites: unknown = Reflect.get(result, key);
	if (!Array.isArray(sites)) throw new Error(`${key} is not a list`);
	return sites
		.map((site: unknown) =>
			typeof site === "object" && site !== null
				? Reflect.get(site, "file")
				: null,
		)
		.filter((file): file is string => typeof file === "string")
		.sort();
}

describe("ream-mcp > integration > docs.trace", () => {
	it("returns implementations + tests for FR37", async () => {
		const result = await dispatchDocs(workDir, "docs.trace", {
			requirement_id: "FR37",
		});
		expect(files(result, "implementations")).toEqual([
			"packages/atlas/src/BaseEntity.ts",
			"packages/atlas/src/Repository.ts",
		]);
		expect(files(result, "tests")).toEqual([
			"packages/atlas/tests/unit/entity.test.ts",
		]);
		expect(result).toMatchObject({ truncated: false, gaps: [] });
	});

	it("returns only the matching id for FR38", async () => {
		const result = await dispatchDocs(workDir, "docs.trace", {
			requirement_id: "FR38",
		});
		expect(files(result, "implementations")).toEqual([
			"packages/atlas/src/BaseEntity.ts",
		]);
	});

	it("reports an unknown id as a gap", async () => {
		const result = await dispatchDocs(workDir, "docs.trace", {
			requirement_id: "FR9999",
		});
		expect(result).toMatchObject({
			implementations: [],
			tests: [],
			gaps: ["FR9999"],
		});
	});

	it("never reads the directories an application keeps its users' files in", async () => {
		// An application user who can upload a `.ts` must not be able to plant
		// an implementation of a requirement in front of the coding agent.
		const big = Buffer.alloc(64 * 1024 * 1024, 0x20);
		Buffer.from("// @implements FR37, MISS-1\n").copy(big, 0);
		plant(join("storage", "uploads", "user-42-avatar.ts"), big);
		plant(join("public", "files", "note.tsx"), "// @implements FR37\n");
		plant(join("tmp", "x.ts"), "// @implements FR37\n");
		plant(join("app", "controllers", "users.ts"), "// @implements FR37\n");
		const result = await dispatchDocs(workDir, "docs.trace", {
			requirement_id: "FR37",
		});
		expect(files(result, "implementations")).toEqual([
			"app/controllers/users.ts",
			"packages/atlas/src/BaseEntity.ts",
			"packages/atlas/src/Repository.ts",
		]);
		const miss = await dispatchDocs(workDir, "docs.trace", {
			requirement_id: "MISS-1",
		});
		expect(miss).toMatchObject({ implementations: [], gaps: ["MISS-1"] });
	});

	it("skips a source file over 256 KB", async () => {
		const big = Buffer.alloc(256 * 1024 + 1, 0x20);
		Buffer.from("// @implements FR90\n").copy(big, 0);
		plant(join("app", "huge.ts"), big);
		const result = await dispatchDocs(workDir, "docs.trace", {
			requirement_id: "FR90",
		});
		expect(result).toMatchObject({ implementations: [], gaps: ["FR90"] });
	});
});
