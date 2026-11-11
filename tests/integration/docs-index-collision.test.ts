/**
 * Two docs pages whose chunk-id prefixes matched on 32 bits (found by a
 * birthday search) and that share their only heading. With a 32-bit prefix
 * both produced the same `chunks.id`, and every index run failed on the
 * UNIQUE constraint from then on.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { core } from "../../index.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ream-mcp-collide-"));
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs", "a.md"), "## Usage\n\nRun it. 47476\n");
	writeFileSync(
		join(root, "docs", "b.md"),
		"## Usage\n\nRun it again. 30253\n",
	);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("docs index > chunk ids", () => {
	it("indexes both pages of a 32-bit prefix collision, then again incrementally", async () => {
		const full: unknown = JSON.parse(await core.indexCorpus(root, true));
		expect(full).toMatchObject({ files_indexed: 2, files_failed: 0 });
		writeFileSync(
			join(root, "docs", "b.md"),
			"## Usage\n\nRun it again. 30253\n\nEdited.\n",
		);
		const again: unknown = JSON.parse(await core.indexCorpus(root, false));
		expect(again).toMatchObject({ files_failed: 0 });
		const hits: unknown = JSON.parse(core.search(root, "Run", ""));
		expect(hits).toHaveProperty(
			"hits",
			expect.arrayContaining([
				expect.objectContaining({
					source: expect.objectContaining({ file: "docs/a.md" }),
				}),
				expect.objectContaining({
					source: expect.objectContaining({ file: "docs/b.md" }),
				}),
			]),
		);
	});
});
