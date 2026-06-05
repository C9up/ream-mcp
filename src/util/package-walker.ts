/**
 * Workspace package enumeration.
 *
 * Story 33.5 — `quality.package_report` and `quality.dep_graph`
 * use this to identify the local packages that count as graph
 * nodes / report rows. External npm packages are NOT walked.
 *
 * The walker is depth-first with hard skips on `node_modules/`
 * and `.git/`. When a `package.json` declares `workspaces`, the
 * walker treats it as a monorepo root and recurses past it
 * (otherwise a Ream app's root `package.json` would mask every
 * nested workspace member). Symlinks are followed but their
 * realpaths are tracked to break cycles.
 *
 * Output is sorted by `name` for determinism.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve as pathResolve, sep } from "node:path";

export interface WorkspacePackage {
	name: string;
	dir: string;
	mainEntry: string;
}

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"target",
	"coverage",
	".next",
	".turbo",
]);

export function walkWorkspacePackages(root: string): WorkspacePackage[] {
	const found: WorkspacePackage[] = [];
	const visited = new Set<string>();
	walk(root, found, visited);
	return found.sort((a, b) => a.name.localeCompare(b.name));
}

function walk(
	dir: string,
	out: WorkspacePackage[],
	visited: Set<string>,
): void {
	let real: string;
	try {
		real = realpathSync(dir);
	} catch {
		return;
	}
	if (visited.has(real)) return;
	visited.add(real);

	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	const hasPackageJson = entries.some(
		(entry) => entry.name === "package.json" && entry.isFile(),
	);
	if (hasPackageJson) {
		const pkg = readPackage(dir);
		if (pkg) {
			out.push(pkg.entry);
			// A workspace-root package.json (declares `workspaces`)
			// does NOT terminate recursion — continue into children
			// so nested members are picked up. Otherwise the root
			// package masks the workspace members.
			if (!pkg.isWorkspaceRoot) return;
		}
		// If the package.json is unparseable, fall through and walk
		// children anyway — better to over-discover than under.
	}

	for (const entry of entries) {
		if (SKIP_DIRS.has(entry.name)) continue;
		if (entry.name.startsWith(".")) continue;
		const childPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(childPath, out, visited);
			continue;
		}
		if (entry.isSymbolicLink()) {
			// `Dirent.isDirectory()` is false for symlinks on most
			// platforms, so pnpm-style symlinked workspace members
			// would be invisible without this branch.
			try {
				const stat = statSync(childPath);
				if (stat.isDirectory()) walk(childPath, out, visited);
			} catch {
				// broken symlink — ignore
			}
		}
	}
}

interface ReadResult {
	entry: WorkspacePackage;
	isWorkspaceRoot: boolean;
}

function readPackage(dir: string): ReadResult | null {
	const pkgJsonPath = join(dir, "package.json");
	let raw: {
		name?: unknown;
		main?: unknown;
		exports?: unknown;
		workspaces?: unknown;
	};
	try {
		raw = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as typeof raw;
	} catch {
		return null;
	}
	if (typeof raw.name !== "string" || raw.name.length === 0) return null;
	const mainEntry = resolveMainEntry(dir, raw);
	if (!mainEntry) return null;
	const isWorkspaceRoot =
		Array.isArray(raw.workspaces) ||
		(typeof raw.workspaces === "object" && raw.workspaces !== null);
	return {
		entry: { name: raw.name, dir, mainEntry },
		isWorkspaceRoot,
	};
}

function resolveMainEntry(
	dir: string,
	pkg: { main?: unknown; exports?: unknown },
): string | null {
	const candidates: string[] = [];
	pushIfSafe(candidates, dir, pkg.main);

	const exp = pkg.exports;
	if (typeof exp === "string") {
		pushIfSafe(candidates, dir, exp);
	} else if (exp && typeof exp === "object" && !Array.isArray(exp)) {
		const root = (exp as Record<string, unknown>)["."];
		if (typeof root === "string") {
			pushIfSafe(candidates, dir, root);
		} else if (root && typeof root === "object" && !Array.isArray(root)) {
			const cond = root as Record<string, unknown>;
			for (const key of ["import", "default", "types", "require"]) {
				const v = cond[key];
				if (typeof v === "string") pushIfSafe(candidates, dir, v);
			}
		}
	}

	candidates.push(
		join(dir, "src", "index.ts"),
		join(dir, "src", "index.tsx"),
		join(dir, "index.ts"),
		join(dir, "index.tsx"),
		join(dir, "src", "index.js"),
		join(dir, "index.js"),
	);

	for (const c of candidates) {
		try {
			if (statSync(c).isFile()) return c;
		} catch {
			// continue
		}
	}
	return null;
}

/**
 * Resolve a candidate entry against `dir` and accept it ONLY if
 * it stays inside `dir`. A `package.json` declaring
 * `"main": "/etc/passwd"` (or `"../../../escape.ts"`) gets
 * dropped silently — defense in depth against malformed or
 * malicious manifests.
 */
function pushIfSafe(candidates: string[], dir: string, value: unknown): void {
	if (typeof value !== "string" || value.length === 0) return;
	if (isAbsolute(value)) return;
	const resolved = pathResolve(dir, value);
	const dirResolved = pathResolve(dir);
	// `path.sep` rather than a hardcoded `/`: on Windows `pathResolve` returns
	// backslash-separated paths, so the `${dir}/` prefix check rejected every
	// legitimate sub-path (`C:\repo\pkg\src\index.ts` doesn't start with
	// `C:\repo\pkg/`). The walker silently detected zero packages on Windows.
	if (resolved !== dirResolved && !resolved.startsWith(dirResolved + sep)) {
		return;
	}
	candidates.push(resolved);
}
