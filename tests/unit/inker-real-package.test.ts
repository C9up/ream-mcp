/**
 * The inker tools against the REAL `@c9up/inker` (an export map with an
 * `import` condition only), not a stand-in: the package this one installs as
 * a devDependency, or, in the workspace before that install links it, the
 * sibling package it is built from. Either way the project under test gets
 * it in its own `node_modules`, as an application does.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RUNS_PROJECT_CODE } from "../../src/tools/descriptor.js";
import { INKER_TOOLS } from "../../src/tools/inker.descriptors.js";
import { dispatchInker } from "../../src/tools/inker.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The real inker package directory: installed, else the workspace sibling. */
function realInkerDir(): string {
	const installed = join(PACKAGE_ROOT, "node_modules/@c9up/inker");
	if (existsSync(join(installed, "package.json"))) return installed;
	const sibling = resolve(PACKAGE_ROOT, "../inker");
	if (existsSync(join(sibling, "package.json"))) return sibling;
	throw new Error(
		"@c9up/inker is a devDependency of this package: run the install",
	);
}

let project: string;

beforeAll(() => {
	project = mkdtempSync(join(tmpdir(), "ream-mcp-real-inker-"));
	writeFileSync(
		join(project, "package.json"),
		'{"name":"app","type":"module"}',
	);
	mkdirSync(join(project, "resources/templates"), { recursive: true });
	writeFileSync(
		join(project, "resources/templates/hello.inker"),
		"Hello {{ name }}!",
	);
	writeFileSync(join(project, "resources/templates/broken.inker"), "@if(x)");
	mkdirSync(join(project, "node_modules/@c9up"), { recursive: true });
	symlinkSync(
		realInkerDir(),
		join(project, "node_modules/@c9up/inker"),
		"junction",
	);
});

afterAll(() => rmSync(project, { recursive: true, force: true }));

interface ListResult {
	templates: Array<{ name: string; error?: { code: string } }>;
	knownGaps: string[];
}

describe("inker tools on the real @c9up/inker", () => {
	it("lint reports the syntax error of a broken template and none for a good one", async () => {
		const res = (await dispatchInker(project, "inker.list_templates", {
			lint: true,
		})) as ListResult;
		expect(res.knownGaps).toEqual([]);
		const byName = new Map(res.templates.map((t) => [t.name, t]));
		expect(byName.get("hello")?.error).toBeUndefined();
		expect(byName.get("broken")?.error?.code).toMatch(/^E_INKER_/);
	});

	it("render_test renders a template", async () => {
		const res = (await dispatchInker(project, "inker.render_test", {
			template: "hello",
			data: { name: "<you>" },
		})) as { html?: string; error?: unknown };
		expect(res.error).toBeUndefined();
		expect(res.html).toBe("Hello &lt;you&gt;!");
	});

	it("both tools say they run the project's code instead of claiming read-only", () => {
		for (const tool of INKER_TOOLS) {
			expect(tool.annotations).toEqual(RUNS_PROJECT_CODE);
			expect(tool.annotations.readOnlyHint).toBe(false);
			expect(tool.description).toContain("runs it in the server process");
		}
	});
});
