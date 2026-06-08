/**
 * Project-root detection.
 *
 * Walks up from `cwd` looking for, in order, a Ream project marker:
 *   1. `reamrc.ts` — canonical config file name.
 *   2. `ream.config.ts` — legacy alias, kept for backwards compat.
 *   3. `package.json` whose deps contain `@c9up/ream`.
 *
 * `REAM_PROJECT_ROOT` env var short-circuits the walk and trusts the
 * caller. Useful for tests and for IDE integrations that resolve the
 * root themselves (e.g. via the workspace folder).
 *
 * Loud, never silent: when no marker is found, throws a structured
 * error with a hint pointing at the env override. Returning `null`
 * here would silently push the misconfiguration downstream into the
 * indexer, where it surfaces as cryptic "no docs found" errors.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join, parse } from "node:path";

export type ProjectRootSource =
	| "env"
	| "reamrc.ts"
	| "ream.config.ts"
	| "package.json";

export interface ProjectRoot {
	path: string;
	source: ProjectRootSource;
}

export function detectProjectRoot(cwd: string = process.cwd()): ProjectRoot {
	const fromEnv = process.env.REAM_PROJECT_ROOT;
	if (fromEnv) {
		return { path: fromEnv, source: "env" };
	}

	let dir = cwd;
	const fsRoot = parse(dir).root;
	while (true) {
		if (fileExists(join(dir, "reamrc.ts"))) {
			return { path: dir, source: "reamrc.ts" };
		}
		if (fileExists(join(dir, "ream.config.ts"))) {
			return { path: dir, source: "ream.config.ts" };
		}
		const pkg = tryReadJson(join(dir, "package.json"));
		if (pkg && hasReamDep(pkg)) {
			return { path: dir, source: "package.json" };
		}
		if (dir === fsRoot) break;
		const next = dirname(dir);
		// `dirname('/')` returns '/' on POSIX — guard against an
		// infinite loop if the OS does something weird.
		if (next === dir) break;
		dir = next;
	}

	throw new Error(
		`ream-mcp: cannot detect a Ream project root walking up from '${cwd}'. ` +
			`Expected to find one of: reamrc.ts, ream.config.ts, or a package.json with '@c9up/ream' as a dependency. ` +
			`Set REAM_PROJECT_ROOT=/path/to/project to override.`,
	);
}

function fileExists(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

function tryReadJson(p: string): Record<string, unknown> | null {
	// One syscall: read+parse, swallow ENOENT and parse errors. The
	// older two-step (statSync → readFileSync) doubled the syscall
	// cost across the walk for no correctness gain.
	try {
		return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function hasReamDep(pkg: Record<string, unknown>): boolean {
	const deps = (pkg.dependencies as Record<string, unknown> | undefined) ?? {};
	const dev =
		(pkg.devDependencies as Record<string, unknown> | undefined) ?? {};
	const peer =
		(pkg.peerDependencies as Record<string, unknown> | undefined) ?? {};
	return "@c9up/ream" in deps || "@c9up/ream" in dev || "@c9up/ream" in peer;
}
