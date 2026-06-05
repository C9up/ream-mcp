/**
 * Test helpers shared across integration suites.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Probe whether the system `tmpdir()` permits executing files we
 * write there. Hardened CIs frequently mount `/tmp` with `noexec`,
 * which makes every `cli-runner` / `generate-*` suite below fail
 * with EPERM at spawn time even though the code under test is fine.
 *
 * Used to short-circuit `describe`-level guards
 * (`describeIfTmpExec = canExecInTmp() ? describe : describe.skip`)
 * so those suites skip cleanly with a stderr note instead of
 * surfacing as flaky EPERM failures.
 *
 * Caches the result for the test-process lifetime (the mount mode
 * does not change mid-run).
 */
let _tmpExecCache: boolean | null = null;
export function canExecInTmp(): boolean {
	if (_tmpExecCache !== null) return _tmpExecCache;
	const probeDir = mkdtempSync(join(tmpdir(), "ream-mcp-exec-probe-"));
	const probePath = join(probeDir, "probe.sh");
	try {
		writeFileSync(probePath, "#!/bin/sh\nexit 0\n");
		chmodSync(probePath, 0o755);
		const result = spawnSync(probePath, [], {
			stdio: "ignore",
			shell: false,
		});
		_tmpExecCache = result.error === undefined && result.status === 0;
	} catch {
		_tmpExecCache = false;
	} finally {
		try {
			rmSync(probeDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup; ignore so the probe result still propagates
		}
	}
	if (!_tmpExecCache) {
		process.stderr.write(
			"[ream-mcp tests] system tmpdir does not permit executing files (likely `noexec` mount); skipping cli-runner / generate-* integration suites.\n",
		);
	}
	return _tmpExecCache;
}

/**
 * Walk upward from this test file looking for `_bmad-output/`.
 * Returns the directory that contains it (the repo root) or
 * `null` if the marker is not present in any ancestor.
 *
 * Honors `REAM_REPO_ROOT` when set so CI / sandboxed environments
 * can pin the location explicitly.
 */
export function findReamRepoRoot(): string | null {
	const override = process.env.REAM_REPO_ROOT;
	if (typeof override === "string" && override.length > 0) {
		return existsSync(`${override}/_bmad-output`) ? override : null;
	}
	const here = dirname(fileURLToPath(import.meta.url));
	let current = here;
	for (let i = 0; i < 12; i++) {
		if (existsSync(`${current}/_bmad-output`)) return current;
		const parent = resolve(current, "..");
		if (parent === current) break;
		current = parent;
	}
	return null;
}
