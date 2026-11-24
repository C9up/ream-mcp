/**
 * Find the entry file of a package installed in the INSPECTED project, the
 * way Node's ESM loader would import it from the project root.
 *
 * `createRequire(project).resolve(name)` resolves with the `require`
 * condition: a package whose export map has an `import` entry only (every
 * `@c9up/*` package) answers `ERR_PACKAGE_PATH_NOT_EXPORTED`, so nothing real
 * could be loaded. `import.meta.resolve` takes no parent without a runtime
 * flag. This reads `node_modules/<name>/package.json` of the project root
 * and picks the `.` export under the `node`, `import` and `default`
 * conditions (then `main`), as the ESM loader does.
 *
 * Only `<root>/node_modules` is looked at, never an ancestor's: a package an
 * ancestor directory holds is not the project's. The entry must stay inside
 * the package directory.
 */

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { isInside, safeRealpath } from "./containment.js";
import { isRecord } from "./guards.js";

export type PackageEntry =
	| { kind: "found"; path: string }
	/** Not installed in the project. */
	| { kind: "missing" }
	/** Installed, but no entry an `import` can load (the reason says why). */
	| { kind: "unresolvable"; reason: string };

const CONDITIONS = ["node", "import", "default"] as const;

export function resolveProjectPackage(
	projectRoot: string,
	name: string,
): PackageEntry {
	const dir = join(projectRoot, "node_modules", ...name.split("/"));
	let manifest: unknown;
	try {
		manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	} catch (err) {
		if (isRecord(err) && err.code === "ENOENT") return { kind: "missing" };
		return { kind: "unresolvable", reason: "its package.json cannot be read" };
	}
	if (!isRecord(manifest)) {
		return {
			kind: "unresolvable",
			reason: "its package.json is not an object",
		};
	}
	const target = rootExport(manifest.exports) ?? fallbackMain(manifest);
	if (target === null) {
		return {
			kind: "unresolvable",
			reason: "its export map has no `.` entry for the import condition",
		};
	}
	if (!target.startsWith("./")) {
		return {
			kind: "unresolvable",
			reason: `its entry '${target}' is not relative`,
		};
	}
	const realDir = safeRealpath(dir);
	const realEntry = safeRealpath(resolve(dir, target));
	if (realDir === null || realEntry === null) {
		return {
			kind: "unresolvable",
			reason: `its entry '${target}' does not exist`,
		};
	}
	if (!isInside(realEntry, realDir)) {
		return {
			kind: "unresolvable",
			reason: `its entry '${target}' leaves the package`,
		};
	}
	try {
		if (!statSync(realEntry).isFile()) {
			return {
				kind: "unresolvable",
				reason: `its entry '${target}' is not a file`,
			};
		}
	} catch {
		return {
			kind: "unresolvable",
			reason: `its entry '${target}' does not exist`,
		};
	}
	return { kind: "found", path: realEntry };
}

/** The `.` target of an `exports` field, or null when there is none for `import`. */
function rootExport(exports: unknown): string | null {
	if (exports === undefined) return null;
	if (typeof exports === "string" || Array.isArray(exports)) {
		return conditionTarget(exports);
	}
	if (!isRecord(exports)) return null;
	const keys = Object.keys(exports);
	// `{ ".": …, "./x": … }` maps subpaths; `{ import: …, default: … }` is the
	// conditions of `.` itself.
	if (keys.some((key) => key.startsWith("."))) {
		return conditionTarget(exports["."]);
	}
	return conditionTarget(exports);
}

function conditionTarget(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const item of value) {
			const target = conditionTarget(item);
			if (target !== null) return target;
		}
		return null;
	}
	if (!isRecord(value)) return null;
	for (const [condition, nested] of Object.entries(value)) {
		if (!CONDITIONS.some((known) => known === condition)) continue;
		const target = conditionTarget(nested);
		if (target !== null) return target;
	}
	return null;
}

/** `main`, or `index.js`, for a package with no `exports` field at all. */
function fallbackMain(manifest: Record<string, unknown>): string | null {
	if (manifest.exports !== undefined) return null;
	const main = typeof manifest.main === "string" ? manifest.main : "index.js";
	return main.startsWith("./") ? main : `./${main}`;
}
