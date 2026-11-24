/**
 * A project root found by walking UP from the working directory is trusted
 * only when the current user owns it and neither group nor others can write
 * to it: a `reamrc.ts` and a `node_modules/.bin/ream` dropped into a shared
 * ancestor must not become the root every tool works on (the generators run
 * that binary, even for a dry run).
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	detectProjectRoot,
	isTrustedDirectory,
} from "../../src/util/project-root.js";

let base: string;
let envBackup: string | undefined;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "ream-mcp-root-trust-"));
	envBackup = process.env.REAM_PROJECT_ROOT;
	delete process.env.REAM_PROJECT_ROOT;
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
	if (envBackup === undefined) delete process.env.REAM_PROJECT_ROOT;
	else process.env.REAM_PROJECT_ROOT = envBackup;
});

/** A shared directory holding what another local user would plant there. */
function plantedShared(mode: number): { shared: string; cwd: string } {
	const shared = join(base, "shared");
	const cwd = join(shared, "alice", "notes");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(shared, "reamrc.ts"), "export default {}\n");
	mkdirSync(join(shared, "node_modules/.bin"), { recursive: true });
	writeFileSync(join(shared, "node_modules/.bin/ream"), "#!/bin/sh\nexit 0\n");
	chmodSync(shared, mode);
	return { shared, cwd };
}

describe("detectProjectRoot — an ancestor root must be the user's own", () => {
	it("refuses a world-writable ancestor holding a reamrc.ts, naming it and the override", () => {
		const { shared, cwd } = plantedShared(0o777);
		expect(() => detectProjectRoot(cwd)).toThrow(
			expect.objectContaining({
				code: "E_REAM_MCP_PROJECT_ROOT_NOT_FOUND",
				message: expect.stringContaining(
					`Found reamrc.ts in '${shared}', but that directory is not owned by the current user or is writable by group or others`,
				),
			}),
		);
		expect(() => detectProjectRoot(cwd)).toThrow(/REAM_PROJECT_ROOT/);
	});

	it("refuses a group-writable ancestor, and one marked by its package.json", () => {
		const shared = join(base, "team");
		const cwd = join(shared, "sub");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(shared, "package.json"),
			JSON.stringify({ dependencies: { "@c9up/ream": "^0.2.0" } }),
		);
		chmodSync(shared, 0o775);
		expect(() => detectProjectRoot(cwd)).toThrow(/Found package\.json in/);
	});

	it("accepts the user's own 0755 root one level up", () => {
		const root = join(base, "app");
		const cwd = join(root, "start");
		mkdirSync(cwd, { recursive: true });
		chmodSync(root, 0o755);
		writeFileSync(join(root, "reamrc.ts"), "export default {}\n");
		expect(detectProjectRoot(cwd)).toEqual({ path: root, source: "reamrc.ts" });
	});

	it("keeps the working directory itself and REAM_PROJECT_ROOT as the user chose them", () => {
		const { shared } = plantedShared(0o777);
		expect(detectProjectRoot(shared)).toEqual({
			path: shared,
			source: "reamrc.ts",
		});
		process.env.REAM_PROJECT_ROOT = shared;
		expect(detectProjectRoot(join(shared, "alice"))).toEqual({
			path: shared,
			source: "env",
		});
	});

	it("reads ownership and mode on the link and on its target", () => {
		const own = join(base, "own");
		mkdirSync(own, { mode: 0o755 });
		chmodSync(own, 0o755);
		expect(isTrustedDirectory(own)).toBe(true);
		chmodSync(own, 0o757);
		expect(isTrustedDirectory(own)).toBe(false);
		expect(isTrustedDirectory(join(base, "missing"))).toBe(false);
		// The user's own link to a directory others can write to.
		const link = join(base, "link");
		symlinkSync(own, link);
		expect(isTrustedDirectory(link)).toBe(false);
		chmodSync(own, 0o755);
		expect(isTrustedDirectory(link)).toBe(true);
		// A directory another account owns: the filesystem root, unless the
		// suite runs as root.
		if (process.getuid?.() !== 0) expect(isTrustedDirectory("/")).toBe(false);
	});
});
