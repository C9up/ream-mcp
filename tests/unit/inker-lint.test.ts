/**
 * `inker.list_templates` with `lint: true`.
 *
 * The lint used to import `@c9up/inker/lex` and `@c9up/inker/parse`, which have
 * never existed — leftovers of a deleted architecture. A `.catch(() => null)`
 * swallowed the failure, so the tool returned every template with no error and
 * `knownGaps: []`: a clean bill of health for a check that never ran. Nothing
 * covered it, which is how it survived.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchInker } from "../../src/tools/inker.js";

/** Narrow away null/undefined without a `!` assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value");
	return value;
}




interface ListResult {
	templates: Array<{
		name: string;
		error?: { code: string; message: string; line?: number };
	}>;
	knownGaps: string[];
}

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "ream-mcp-lint-"));
	mkdirSync(join(tmpRoot, "resources/templates"), { recursive: true });
	writeFileSync(join(tmpRoot, "package.json"), '{"name":"app"}');
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * A stand-in for the project's inker: the tool's contract is a module exporting
 * `Templates` with `compileRaw`, and testing against that rather than a pinned
 * published version keeps this test independent of inker's release cycle.
 */
function installFakeInker(body: string): void {
	const dir = join(tmpRoot, "node_modules/@c9up/inker");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			name: "@c9up/inker",
			version: "0.0.0",
			main: "index.cjs",
		}),
	);
	writeFileSync(join(dir, "index.cjs"), body);
}

describe("inker.list_templates > lint", () => {
	it("says so when the project has no inker, instead of reporting no errors", async () => {
		writeFileSync(join(tmpRoot, "resources/templates/a.inker"), "@if(x)");

		const res = (await dispatchInker(tmpRoot, "inker.list_templates", {
			lint: true,
		})) as ListResult;

		expect(res.knownGaps.join(" ")).toMatch(/could not be loaded/);
		expect(defined(res.templates[0]).error).toBeUndefined();
	});

	it("attaches the parse error a template actually has", async () => {
		installFakeInker(`
			class Templates {
				compileRaw(source, name) {
					if (source.includes("@if") && !source.includes("@endif")) {
						const err = new Error("Unclosed @if in " + name);
						err.code = "E_INKER_UNCLOSED_BLOCK_TAG";
						err.context = { line: 1, column: 1 };
						throw err;
					}
				}
			}
			module.exports = { Templates };
		`);
		writeFileSync(join(tmpRoot, "resources/templates/bad.inker"), "@if(x)");
		writeFileSync(
			join(tmpRoot, "resources/templates/good.inker"),
			"@if(x)@endif",
		);

		const res = (await dispatchInker(tmpRoot, "inker.list_templates", {
			lint: true,
		})) as ListResult;

		expect(res.knownGaps).toEqual([]);
		const byName = new Map(res.templates.map((t) => [t.name, t]));
		expect(byName.get("good")?.error).toBeUndefined();
		expect(byName.get("bad")?.error?.code).toBe("E_INKER_UNCLOSED_BLOCK_TAG");
		// The template name is passed through, so the message names the file.
		expect(byName.get("bad")?.error?.message).toContain("bad");
	});

	it("reports a gap when the project's inker is too old to compile", async () => {
		// An inker without compileRaw must not be treated as "nothing to report".
		installFakeInker("module.exports = { Templates: class {} };");
		writeFileSync(join(tmpRoot, "resources/templates/a.inker"), "@if(x)");

		const res = (await dispatchInker(tmpRoot, "inker.list_templates", {
			lint: true,
		})) as ListResult;

		expect(res.knownGaps.join(" ")).toMatch(/could not be loaded/);
	});

	it("does not load inker at all without lint", async () => {
		installFakeInker("throw new Error('must not be imported')");
		writeFileSync(join(tmpRoot, "resources/templates/a.inker"), "@if(x)");

		const res = (await dispatchInker(
			tmpRoot,
			"inker.list_templates",
		)) as ListResult;

		expect(res.knownGaps).toEqual([]);
		expect(res.templates).toHaveLength(1);
	});
});

describe("inker.render_test > engine source", () => {
	it("renders through the INSPECTED project's inker", async () => {
		installFakeInker(`
			class Templates {
				constructor(opts) { this.root = opts.root }
				async render(name, data) {
					return "rendered " + name + " for " + data.who + " from " + this.root
				}
			}
			module.exports = { Templates };
		`);
		writeFileSync(join(tmpRoot, "resources/templates/hello.inker"), "hi");

		const res = (await dispatchInker(tmpRoot, "inker.render_test", {
			template: "hello",
			data: { who: "you" },
		})) as { html?: string; error?: unknown };

		expect(res.html).toContain("rendered hello for you");
		// Rooted at the project's templates directory, not ream-mcp's own. The
		// separator is normalised: Windows renders it with backslashes.
		expect(res.html?.replace(/\\/g, "/")).toContain("resources/templates");
	});

	it("reports a shaped error when the project has no inker", async () => {
		writeFileSync(join(tmpRoot, "resources/templates/hello.inker"), "hi");

		const res = (await dispatchInker(tmpRoot, "inker.render_test", {
			template: "hello",
		})) as { error?: string; hint?: string };

		expect(res.error).toMatch(/Failed to load @c9up\/inker/);
		expect(res.hint).toMatch(/ream add/);
	});
});
