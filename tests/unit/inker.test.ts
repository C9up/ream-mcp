import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchInker } from "../../src/tools/inker.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "ream-mcp-inker-"));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("inker.list_templates", () => {
	it("returns an empty list when the templates root doesn't exist (structured error)", async () => {
		const res = (await dispatchInker(tmpRoot, "inker.list_templates")) as {
			error?: string;
			hint?: string;
		};
		expect(res.error).toMatch(/Templates root not found/);
		expect(res.hint).toMatch(/resources\/templates/);
	});

	it("walks .inker files recursively and returns them sorted", async () => {
		const root = join(tmpRoot, "resources/templates");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "welcome.inker"), "Hello {{ name }}");
		mkdirSync(join(root, "pages"), { recursive: true });
		writeFileSync(join(root, "pages/about.inker"), "About");
		writeFileSync(join(root, "ignored.txt"), "not a template");

		const res = (await dispatchInker(tmpRoot, "inker.list_templates")) as {
			templates: Array<{ name: string; relPath: string; sizeBytes: number }>;
			confidence: string;
		};
		expect(res.templates.map((t) => t.name).sort()).toEqual([
			"pages/about",
			"welcome",
		]);
		expect(res.confidence).toBe("high");
	});

	it("honours the `root` override", async () => {
		const custom = join(tmpRoot, "custom");
		mkdirSync(custom, { recursive: true });
		writeFileSync(join(custom, "x.inker"), "x");
		const res = (await dispatchInker(tmpRoot, "inker.list_templates", {
			root: "custom",
		})) as { templates: Array<{ name: string }> };
		expect(res.templates).toHaveLength(1);
		expect(res.templates[0].name).toBe("x");
	});
});

describe("inker.render_test", () => {
	it("rejects when `template` is missing", async () => {
		const res = (await dispatchInker(tmpRoot, "inker.render_test")) as {
			error?: string;
		};
		expect(res.error).toMatch(/missing required argument 'template'/);
	});

	it("rejects when templates root is absent", async () => {
		const res = (await dispatchInker(tmpRoot, "inker.render_test", {
			template: "x",
		})) as { error?: string };
		expect(res.error).toMatch(/Templates root not found/);
	});
});
