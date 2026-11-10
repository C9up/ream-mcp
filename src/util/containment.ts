/**
 * Path containment on REAL paths.
 *
 * A lexical check (`relative(root, p)` has no `..`) is defeated by any symlink
 * inside the project, and a cloned repository controls its own symlinks. Every
 * "is this inside the project" decision goes through the realpath of both
 * sides.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** True when `candidate` is `root` or below it. Both must already be real paths. */
export function isInside(candidate: string, root: string): boolean {
	const rel = relative(root, candidate);
	if (rel === "") return true;
	if (isAbsolute(rel)) return false;
	return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** `realpathSync` that answers null instead of throwing. */
export function safeRealpath(p: string): string | null {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
}

/**
 * Realpath of `p`, or — when it does not exist yet (a file about to be
 * created) — realpath of its nearest existing ancestor joined with the missing
 * tail, so a symlinked directory cannot hide where the file lands.
 */
export function realpathOfNearest(p: string): string | null {
	let current = resolve(p);
	const tail: string[] = [];
	for (;;) {
		if (existsSync(current)) {
			const real = safeRealpath(current);
			return real === null ? null : resolve(real, ...tail.reverse());
		}
		const parent = dirname(current);
		if (parent === current) return null;
		tail.push(relative(parent, current));
		current = parent;
	}
}

/**
 * The realpath of `candidate` when it exists and stays inside the realpath of
 * `root`, else null.
 */
export function realpathInside(candidate: string, root: string): string | null {
	const realRoot = safeRealpath(root);
	const real = safeRealpath(candidate);
	if (realRoot === null || real === null) return null;
	return isInside(real, realRoot) ? real : null;
}
