/**
 * Integration test for `core.auditDrift` — write a doc, index it,
 * mutate it, assert drift detection. Uses an offline embed cache to
 * avoid touching the network.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { core } from "../../index.js";

let workDir: string;
let envBackup: string | undefined;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "ream-mcp-drift-"));
	envBackup = process.env.REAM_MCP_EMBED_CACHE_DIR;
	process.env.REAM_MCP_EMBED_CACHE_DIR = "/dev/null/no-cache";
	mkdirSync(join(workDir, "packages", "demo"), { recursive: true });
	writeFileSync(
		join(workDir, "packages", "demo", "README.md"),
		"# Demo\n\n## Section\n\nbody.\n",
	);
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
	if (envBackup === undefined) {
		delete process.env.REAM_MCP_EMBED_CACHE_DIR;
	} else {
		process.env.REAM_MCP_EMBED_CACHE_DIR = envBackup;
	}
});

describe("ream-mcp > integration > docs.audit_drift", () => {
	it("flags a file whose mtime advanced after indexing", async () => {
		core.indexCorpus(workDir, true);
		// Sleep long enough that the new mtime is strictly greater than
		// the indexed one (1 ms granularity on most FS).
		await new Promise((resolve) => setTimeout(resolve, 50));
		writeFileSync(
			join(workDir, "packages", "demo", "README.md"),
			"# Demo\n\n## Section\n\nUpdated body.\n",
		);
		const json = core.auditDrift(workDir);
		const drifted = JSON.parse(json);
		expect(drifted.length).toBeGreaterThanOrEqual(1);
		expect(
			drifted.some((d: { file: string }) => d.file.includes("demo/README.md")),
		).toBe(true);
	});

	it("returns an empty list when nothing has changed", () => {
		core.indexCorpus(workDir, true);
		const json = core.auditDrift(workDir);
		const drifted = JSON.parse(json);
		expect(drifted).toEqual([]);
	});

	it("flags deleted files via current_mtime sentinel", () => {
		core.indexCorpus(workDir, true);
		rmSync(join(workDir, "packages", "demo", "README.md"));
		const json = core.auditDrift(workDir);
		const drifted = JSON.parse(json);
		const gone = drifted.find((d: { file: string }) =>
			d.file.includes("demo/README.md"),
		);
		expect(gone).toBeDefined();
		expect(gone.current_mtime).toBe(-1);
	});
});
