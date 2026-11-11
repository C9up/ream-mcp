/**
 * The startup reindex must not hold the event loop: the server connects its
 * transport right after starting it, and an MCP `initialize` that cannot be
 * read until the whole corpus is indexed times out on a large project.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { core } from "../../index.js";
import {
	indexReady,
	startStartupReindex,
} from "../../src/util/startup-reindex.js";

const saved = process.env.REAM_PROJECT_ROOT;
let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "ream-mcp-startup-"));
	writeFileSync(join(root, "reamrc.ts"), "export default {}\n");
	mkdirSync(join(root, "docs"));
	const section = "Routing, middleware and the container explained. ".repeat(
		40,
	);
	for (let i = 0; i < 200; i++) {
		writeFileSync(
			join(root, "docs", `page-${i}.md`),
			`# Page ${i}\n\n## Overview\n\n${section}\n\n## Details ${i}\n\n${section}\n`,
		);
	}
	process.env.REAM_PROJECT_ROOT = root;
});

afterAll(() => {
	if (saved === undefined) delete process.env.REAM_PROJECT_ROOT;
	else process.env.REAM_PROJECT_ROOT = saved;
	rmSync(root, { recursive: true, force: true });
});

describe("startup reindex", () => {
	it("returns at once and lets the event loop run while it indexes", async () => {
		let ticks = 0;
		const ticker = setInterval(() => {
			ticks++;
		}, 1);
		const t0 = performance.now();
		startStartupReindex();
		const returnedAfter = performance.now() - t0;
		const ticksAtReturn = ticks;
		await indexReady;
		clearInterval(ticker);
		// Synchronous, the call itself was the whole index and no timer could
		// fire before it returned.
		expect(ticksAtReturn).toBe(0);
		expect(ticks).toBeGreaterThan(0);
		expect(returnedAfter).toBeLessThan(50);
		// And the index it ran is the one the docs tools then read.
		const result: unknown = JSON.parse(core.search(root, "middleware", ""));
		expect(result).toHaveProperty("hits", expect.any(Array));
		expect(result).toHaveProperty(
			"hits",
			expect.arrayContaining([
				expect.objectContaining({
					source: expect.objectContaining({
						file: expect.stringMatching(/^docs\//),
					}),
				}),
			]),
		);
	});
});
