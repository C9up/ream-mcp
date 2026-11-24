/**
 * What the security checks need to know about the application as a whole,
 * read once per scan: the `@c9up/ream` version it runs and its dependencies.
 *
 * Some verdicts depend on the framework version. From ream 0.2.32 a cookie
 * gets `Secure`, `SameSite=lax` and `HttpOnly` by default, and the route gate
 * enforces a lone `@RequireMfa()` (401 for an anonymous request); before it,
 * neither held. The version is read as data only, never imported:
 *
 *   1. `node_modules/@c9up/ream/package.json`, the version installed (exact);
 *   2. otherwise the `@c9up/ream` range in the application's `package.json`,
 *      whose lower bound is a minimum (`^0.2.32` means at least 0.2.32).
 *
 * When neither answers, a check that needs the version says so in
 * `knownGaps` and assumes the older behaviour.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { isRecord } from "../../util/guards.js";

export type Version = readonly [number, number, number];

export interface ReamVersion {
	version: Version;
	/** True for the installed version, false for the lower bound of a range. */
	exact: boolean;
}

export interface ProjectFacts {
	reamVersion: ReamVersion | null;
	/** Names in `dependencies` and `devDependencies` of the application's `package.json`. */
	dependencies: ReadonlySet<string>;
}

/** The first ream release with cookie defaults and a gate that enforces `@RequireMfa()`. */
export const REAM_SECURE_DEFAULTS: Version = [0, 2, 32];

/** A manifest larger than this is not a package manifest. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

export function readProjectFacts(root: string): ProjectFacts {
	const manifest = readJson(join(root, "package.json"));
	const dependencies = new Set<string>();
	let declared: string | null = null;
	if (manifest !== null) {
		for (const field of ["dependencies", "devDependencies"]) {
			const deps = manifest[field];
			if (!isRecord(deps)) continue;
			for (const [name, range] of Object.entries(deps)) {
				dependencies.add(name);
				if (name === "@c9up/ream" && typeof range === "string") {
					declared = range;
				}
			}
		}
	}
	return {
		reamVersion: installedReam(root) ?? rangeFloor(declared),
		dependencies,
	};
}

function installedReam(root: string): ReamVersion | null {
	const installed = readJson(
		join(root, "node_modules", "@c9up", "ream", "package.json"),
	);
	const version = parseVersion(installed?.version);
	return version === null ? null : { version, exact: true };
}

/**
 * `x.y.z` pinned exactly, or the lower bound of `^x.y.z`, `~x.y.z`,
 * `>=x.y.z`; null for anything else (`workspace:*`, a tag, a URL).
 */
function rangeFloor(range: string | null): ReamVersion | null {
	if (range === null) return null;
	const match = /^\s*(\^|~|>=)?\s*v?(\d+\.\d+\.\d+)\s*$/.exec(range);
	const version = parseVersion(match?.[2]);
	if (version === null) return null;
	return { version, exact: match?.[1] === undefined };
}

function parseVersion(value: unknown): Version | null {
	if (typeof value !== "string") return null;
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function readJson(path: string): Record<string, unknown> | null {
	try {
		if (statSync(path).size > MAX_MANIFEST_BYTES) return null;
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function compare(a: Version, b: Version): number {
	for (let i = 0; i < 3; i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * Whether the application runs ream `min` or later: `true`, `false`, or
 * `null` when the version is unknown, or only a lower bound below `min`.
 */
export function reamAtLeast(facts: ProjectFacts, min: Version): boolean | null {
	const known = facts.reamVersion;
	if (known === null) return null;
	if (compare(known.version, min) >= 0) return true;
	return known.exact ? false : null;
}

/** The `knownGaps` line for a verdict that needed the ream version and did not have it. */
export function versionGap(feature: string): string {
	return `the @c9up/ream version was not found (node_modules/@c9up/ream/package.json, or a range in package.json from ${REAM_SECURE_DEFAULTS.join(".")}): ${feature} read as before ream ${REAM_SECURE_DEFAULTS.join(".")}`;
}

/** Push `gap` once. */
export function pushGapOnce(knownGaps: string[], gap: string): void {
	if (!knownGaps.includes(gap)) knownGaps.push(gap);
}
