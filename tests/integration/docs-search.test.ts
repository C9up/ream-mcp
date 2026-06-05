/**
 * Integration test for `docs.search` against a synthetic corpus.
 *
 * Uses `REAM_MCP_EMBED_CACHE_DIR=/dev/null` to force the offline
 * embedding path — this isolates the test from network availability
 * and exercises the `confidence: "low"` BM25-only fallback (which
 * is the load-bearing path documented in the story spec).
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { core } from "../../index.js";

let workDir: string;
let envBackup: string | undefined;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "ream-mcp-search-"));
	envBackup = process.env.REAM_MCP_EMBED_CACHE_DIR;
	// Force offline embedding path — keeps the test deterministic and
	// network-independent.
	process.env.REAM_MCP_EMBED_CACHE_DIR = "/dev/null/no-cache";
	mkdirSync(join(workDir, "packages", "atlas"), { recursive: true });
	mkdirSync(join(workDir, "_bmad-output", "planning-artifacts"), {
		recursive: true,
	});
	writeFileSync(
		join(workDir, "packages", "atlas", "README.md"),
		[
			"# Atlas",
			"",
			"## Entity declaration",
			"",
			"Use the `@Entity()` decorator to declare a class as a database entity.",
			"Each entity maps to a table; columns map via `@Column`.",
			"",
			"## Repository pattern",
			"",
			"Atlas wraps queries through `BaseRepository.create()`.",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(workDir, "packages", "atlas", "CORRECTIONS.md"),
		"# Atlas corrections\n\nSee VitePress.\n",
	);
	writeFileSync(
		join(workDir, "_bmad-output", "planning-artifacts", "epics.md"),
		"# Epics\n\n## Epic 33\n\nMCP server.\n",
	);
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
	try {
		execSync(`rm -rf ${join(workDir, ".ream-mcp")}`);
	} catch {
		// Already cleaned by rmSync.
	}
	if (envBackup === undefined) {
		delete process.env.REAM_MCP_EMBED_CACHE_DIR;
	} else {
		process.env.REAM_MCP_EMBED_CACHE_DIR = envBackup;
	}
});

describe("ream-mcp > integration > docs.search", () => {
	it("indexes a synthetic corpus and returns ranked hits for a relevant query", () => {
		const stats = JSON.parse(core.indexCorpus(workDir, true));
		expect(stats.files_indexed).toBeGreaterThanOrEqual(2);
		expect(stats.chunks_total).toBeGreaterThan(0);

		const json = core.search(workDir, "Entity declaration decorator", "");
		const result = JSON.parse(json);
		expect(Array.isArray(result.hits)).toBe(true);
		expect(result.hits.length).toBeGreaterThan(0);
		// The Atlas entity-declaration chunk should rank top-1 for this
		// query.
		const top = result.hits[0];
		expect(top.source.file).toContain("packages/atlas/README.md");
		expect(top.content.toLowerCase()).toContain("entity");
	});

	it("respects the package filter", () => {
		core.indexCorpus(workDir, true);
		const opts = JSON.stringify({ package: "atlas" });
		const json = core.search(workDir, "decorator entity", opts);
		const result = JSON.parse(json);
		for (const hit of result.hits) {
			expect(hit.package).toBe("atlas");
		}
	});

	it("respects the type filter", () => {
		core.indexCorpus(workDir, true);
		const opts = JSON.stringify({ type: "Bmad" });
		const json = core.search(workDir, "MCP epic", opts);
		const result = JSON.parse(json);
		for (const hit of result.hits) {
			expect(hit.kind).toBe("Bmad");
		}
	});

	it("returns BM25-only confidence when embeddings are offline", () => {
		core.indexCorpus(workDir, true);
		const json = core.search(workDir, "entity", "");
		const result = JSON.parse(json);
		expect(["low", "medium", "high"]).toContain(result.confidence);
		// Offline cache path → confidence is "low" because
		// embeddings can't load AND sqlite-vec isn't loaded.
		expect(result.confidence).toBe("low");
		expect(result.knownGaps.length).toBeGreaterThan(0);
	});

	it("respects the limit option", () => {
		core.indexCorpus(workDir, true);
		const opts = JSON.stringify({ limit: 2 });
		const json = core.search(workDir, "entity decorator", opts);
		const result = JSON.parse(json);
		expect(result.hits.length).toBeLessThanOrEqual(2);
	});
});
