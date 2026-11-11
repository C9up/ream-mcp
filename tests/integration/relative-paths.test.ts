/**
 * A tool result names files relative to the project root, with forward
 * slashes: the machine's layout (`/home/<user>/...`) never reaches the agent,
 * on success any more than on failure.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dispatchBmad } from "../../src/tools/bmad.js";
import { dispatchDocs } from "../../src/tools/docs.js";
import { dispatchIntrospect } from "../../src/tools/introspect.js";
import { dispatchScheduler } from "../../src/tools/scheduler.js";
import { dispatchStation } from "../../src/tools/station.js";
import { BMAD_FIXTURE_ROOT } from "../test-utils.js";

const INTROSPECT_APP = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"introspect-app",
);

/** Every `file` value anywhere in `value`. */
function files(value: unknown, out: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (const v of value) files(v, out);
	} else if (typeof value === "object" && value !== null) {
		for (const [k, v] of Object.entries(value)) {
			if (k === "file" && typeof v === "string") out.push(v);
			else files(v, out);
		}
	}
	return out;
}

function expectProjectRelative(result: unknown, root: string): string[] {
	const found = files(result);
	expect(found.length).toBeGreaterThan(0);
	for (const file of found) {
		expect(file).not.toMatch(/^([/\\]|[A-Za-z]:)/);
		expect(file).not.toContain("\\");
	}
	expect(JSON.stringify(result)).not.toContain(root);
	return found;
}

describe("tool results carry project-relative paths", () => {
	for (const tool of [
		"list.routes",
		"list.entities",
		"list.events",
		"list.providers",
		"list.middleware",
	]) {
		it(tool, () => {
			const found = expectProjectRelative(
				dispatchIntrospect(INTROSPECT_APP, tool),
				INTROSPECT_APP,
			);
			expect(found.every((f) => f.startsWith("app/"))).toBe(true);
		});
	}

	it("bmad.locate", async () => {
		const saved = process.env.REAM_BMAD_ROOT;
		delete process.env.REAM_BMAD_ROOT;
		try {
			const result = await dispatchBmad(BMAD_FIXTURE_ROOT, "bmad.locate", {});
			expect(JSON.stringify(result)).not.toContain(BMAD_FIXTURE_ROOT);
			expect(result).toMatchObject({ root: "_bmad-output" });
		} finally {
			if (saved !== undefined) process.env.REAM_BMAD_ROOT = saved;
		}
	});

	describe("on a project with scheduled tasks, resources and a symbol", () => {
		let root: string;

		beforeAll(() => {
			root = mkdtempSync(join(tmpdir(), "ream-mcp-relpaths-"));
			mkdirSync(join(root, "app"));
			writeFileSync(
				join(root, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						target: "ES2022",
						module: "ESNext",
						experimentalDecorators: true,
					},
					include: ["app/**/*.ts"],
				}),
			);
			writeFileSync(
				join(root, "app", "cleanup.ts"),
				[
					'import { Schedule } from "@c9up/ream";',
					'import { defineResource } from "@c9up/station";',
					"export class Cleanup {",
					'  @Schedule("0 */5 * * *")',
					"  async runCleanup() {}",
					"}",
					"class Article {}",
					'export const articles = defineResource({ name: "articles", entity: Article });',
					"",
				].join("\n"),
			);
		});

		afterAll(() => {
			rmSync(root, { recursive: true, force: true });
		});

		it("scheduler.list_tasks", () => {
			const found = expectProjectRelative(
				dispatchScheduler(root, "scheduler.list_tasks"),
				root,
			);
			expect(found).toEqual(["app/cleanup.ts"]);
		});

		it("station.list_resources", () => {
			const found = expectProjectRelative(
				dispatchStation(root, "station.list_resources"),
				root,
			);
			expect(found).toEqual(["app/cleanup.ts"]);
		});

		it("docs.explain", async () => {
			const found = expectProjectRelative(
				await dispatchDocs(root, "docs.explain", { symbol: "Cleanup" }),
				root,
			);
			expect(found).toEqual(["app/cleanup.ts"]);
		});
	});
});
