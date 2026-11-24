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
 * A root found ABOVE the working directory is trusted only when the current
 * user owns it and neither group nor others can write to it (POSIX), git's
 * `safe.directory` rule. Every tool works on this root, and the generators
 * run its `node_modules/.bin/ream`: a `reamrc.ts` another local user dropped
 * into a shared ancestor (`/tmp`, a shared workspace) must not make the
 * server adopt that directory. The working directory itself, and
 * `REAM_PROJECT_ROOT`, are the user's own choice and are not checked. On
 * Windows the mode bits are synthetic and ACLs govern access, so the check
 * is POSIX only, as for `REAM_BIN`.
 *
 * Loud, never silent: when no marker is found, throws a structured
 * error with a hint pointing at the env override. Returning `null`
 * here would silently push the misconfiguration downstream into the
 * indexer, where it surfaces as cryptic "no docs found" errors.
 */

import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { E_REAM_MCP_PROJECT_ROOT_NOT_FOUND } from "../errors.js";
import { isRecord } from "./guards.js";

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
		const source = markerOf(dir);
		if (source !== null) {
			if (dir === cwd || isTrustedDirectory(dir)) return { path: dir, source };
			throw new E_REAM_MCP_PROJECT_ROOT_NOT_FOUND([
				cwd,
				`Found ${source} in '${dir}', but that directory is not owned by the current user or is writable by group or others, so it is not trusted as the project root.`,
			]);
		}
		if (dir === fsRoot) break;
		const next = dirname(dir);
		// `dirname('/')` returns '/' on POSIX — guard against an
		// infinite loop if the OS does something weird.
		if (next === dir) break;
		dir = next;
	}

	throw new E_REAM_MCP_PROJECT_ROOT_NOT_FOUND([
		cwd,
		"Expected to find one of: reamrc.ts, ream.config.ts, or a package.json with '@c9up/ream' as a dependency.",
	]);
}

/** The Ream project marker `dir` holds, or null. */
function markerOf(dir: string): ProjectRootSource | null {
	if (fileExists(join(dir, "reamrc.ts"))) return "reamrc.ts";
	if (fileExists(join(dir, "ream.config.ts"))) return "ream.config.ts";
	const pkg = tryReadJson(join(dir, "package.json"));
	return pkg && hasReamDep(pkg) ? "package.json" : null;
}

/**
 * Owned by the current user and not writable by group or others. A symlink
 * must be the user's own too (its mode bits mean nothing), and what it points
 * at must pass the whole rule.
 */
export function isTrustedDirectory(dir: string): boolean {
	if (process.platform === "win32" || typeof process.getuid !== "function") {
		return true;
	}
	const uid = process.getuid();
	try {
		const link = lstatSync(dir);
		if (link.uid !== uid) return false;
		const target = link.isSymbolicLink() ? statSync(realpathSync(dir)) : link;
		return target.uid === uid && (target.mode & 0o022) === 0;
	} catch {
		return false;
	}
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
		const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function hasReamDep(pkg: Record<string, unknown>): boolean {
	// A dependency field that is not an object (a string, an array, null) is
	// a malformed package.json, not a Ream one; `in` on a string would throw.
	return [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies].some(
		(deps) => isRecord(deps) && "@c9up/ream" in deps,
	);
}
