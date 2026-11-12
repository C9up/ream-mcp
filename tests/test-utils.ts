/**
 * Test helpers shared across integration suites.
 */

import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A committed project root holding a small `_bmad-output/` (epics.md,
 * sprint-status.yaml, one implementation artifact), so the `bmad.*` suites
 * run on every machine instead of depending on a live planning tree.
 */
export const BMAD_FIXTURE_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"bmad-root",
);

/**
 * Remove a temp project whose docs index the test opened. `core.indexCorpus`,
 * `core.search` and the startup reindex open `<project>/.ream-mcp/index.sqlite`
 * through the native store cache (`STATE` in crates/ream-mcp-napi/src/lib.rs),
 * which keeps the connection for the life of the process and has no release
 * call. Linux unlinks an open file; Windows refuses (EPERM / EBUSY on the
 * file, ENOTEMPTY on its directory), and no retry helps since the handle is
 * never dropped. Only that refusal is tolerated, and only on Windows: the
 * runner's temp dir is discarded with the VM.
 */
export function removeIndexedProject(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch (err) {
		if (!isWindowsOpenFileLock(err)) throw err;
	}
}

function isWindowsOpenFileLock(err: unknown): boolean {
	if (process.platform !== "win32") return false;
	const code =
		typeof err === "object" && err !== null && "code" in err
			? err.code
			: undefined;
	return code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY";
}
