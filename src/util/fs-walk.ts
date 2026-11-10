/**
 * The one directory walker behind every tool that reads "the project".
 *
 * A cloned repository controls its own symlinks, so the walk must terminate
 * and stay inside the project whatever the tree contains:
 *
 *   - every directory is entered by realpath, at most once, and only when that
 *     realpath is inside the realpath of the project root — `src/l -> .` loops
 *     end, `src/ext -> /elsewhere` is not followed;
 *   - a symlinked file is read only when its target is inside the project too;
 *   - recursion stops (not only collection) once `maxFiles` is reached, and
 *     at `maxDepth`.
 *
 * Returned paths are the walked paths (not realpaths), so they read as the
 * project lays them out.
 */

import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { isInside, safeRealpath } from "./containment.js";

const DEFAULT_MAX_DEPTH = 64;

export interface WalkOptions {
	/** Nothing whose realpath leaves this directory is visited. */
	projectRoot: string;
	/** Directory names never entered. */
	skipDirs?: ReadonlySet<string>;
	/** Skip entries whose name starts with `.` (default true). */
	skipDotEntries?: boolean;
	/** Keep a file, given its name. */
	accept: (name: string) => boolean;
	maxFiles: number;
	maxDepth?: number;
}

export interface WalkResult {
	files: string[];
	/** True when `maxFiles` stopped the walk. */
	capped: boolean;
}

/** Walk `startDirs` in order, sharing one visited set and one file budget. */
export function walkProjectFiles(
	startDirs: readonly string[],
	opts: WalkOptions,
): WalkResult {
	const result: WalkResult = { files: [], capped: false };
	const realRoot = safeRealpath(opts.projectRoot);
	if (realRoot === null) return result;
	const state: WalkState = {
		opts,
		realRoot,
		visited: new Set<string>(),
		seenFiles: new Set<string>(),
		maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH,
		skipDot: opts.skipDotEntries ?? true,
		result,
	};
	for (const dir of startDirs) {
		if (result.capped) break;
		walkDir(dir, 0, state);
	}
	return result;
}

interface WalkState {
	opts: WalkOptions;
	realRoot: string;
	visited: Set<string>;
	seenFiles: Set<string>;
	maxDepth: number;
	skipDot: boolean;
	result: WalkResult;
}

function walkDir(dir: string, depth: number, state: WalkState): void {
	if (state.result.capped || depth > state.maxDepth) return;
	const real = safeRealpath(dir);
	if (real === null || !isInside(real, state.realRoot)) return;
	if (state.visited.has(real)) return;
	state.visited.add(real);

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (state.result.capped) return;
		if (state.skipDot && entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		let isDir = entry.isDirectory();
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				const s = statSync(full);
				isDir = s.isDirectory();
				isFile = s.isFile();
			} catch {
				continue;
			}
		}
		if (isDir) {
			if (state.opts.skipDirs?.has(entry.name)) continue;
			walkDir(full, depth + 1, state);
			continue;
		}
		if (!isFile || !state.opts.accept(entry.name)) continue;
		if (entry.isSymbolicLink()) {
			const target = safeRealpath(full);
			if (target === null || !isInside(target, state.realRoot)) continue;
		}
		// The same file reached through two in-project paths is listed once.
		const key = safeRealpath(full) ?? full;
		if (state.seenFiles.has(key)) continue;
		if (state.result.files.length >= state.opts.maxFiles) {
			state.result.capped = true;
			return;
		}
		state.seenFiles.add(key);
		state.result.files.push(full);
	}
}
