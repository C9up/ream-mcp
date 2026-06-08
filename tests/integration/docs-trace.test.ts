/**
 * Integration test for `core.trace` — `@implements` traceability
 * scanner. Uses a synthetic packages/ tree so we don't depend on the
 * real monorepo state (which would change between commits).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { core } from "../../index.js";

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

describe("ream-mcp > integration > docs.trace", () => {
	it("returns implementations + tests for FR37", () => {
		const json = core.trace(workDir, "FR37");
		const sites = JSON.parse(json) as Array<{ file: string; line: number }>;
		expect(sites.length).toBe(3);
		const files = sites.map((s) => s.file).sort();
		expect(files).toEqual([
			"packages/atlas/src/BaseEntity.ts",
			"packages/atlas/src/Repository.ts",
			"packages/atlas/tests/unit/entity.test.ts",
		]);
	});

	it("returns only the matching id for FR38", () => {
		const json = core.trace(workDir, "FR38");
		const sites = JSON.parse(json);
		expect(sites.length).toBe(1);
		expect(sites[0].file).toBe("packages/atlas/src/BaseEntity.ts");
	});

	it("returns an empty list for an unknown id", () => {
		const json = core.trace(workDir, "FR9999");
		const sites = JSON.parse(json);
		expect(sites).toEqual([]);
	});
});
