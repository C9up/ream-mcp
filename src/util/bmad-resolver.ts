/**
 * BMAD root resolution — Story 33.8.
 *
 * Five-tier priority order:
 *
 *   1. `bmadRoot` field in `<root>/reamrc.ts`
 *      (top-level `export default { bmadRoot: "..." }`)
 *   2. `process.env.REAM_BMAD_ROOT`
 *   3. `<root>/_bmad-output/`
 *   4. `<root>/ream-legacy/_bmad-output/`
 *   5. `<root>/.bmad/`
 *
 * The first tier whose path exists wins. The full candidate
 * trace is preserved so `bmad.locate` can debug resolution.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

import { Node, Project, SyntaxKind } from "ts-morph";

import { evaluateLiteral, extractEnvRef } from "./ts-static-parser.js";

export type Tier = "reamrc" | "env" | "default" | "legacy" | "flat";

export interface Candidate {
	tier: Tier;
	path: string;
	exists: boolean;
}

export interface ResolveResult {
	root: string;
	tier: Tier;
	candidates: Candidate[];
}

const TIERS: ReadonlyArray<{ tier: Tier; subdir: string | null }> = [
	{ tier: "default", subdir: "_bmad-output" },
	{ tier: "legacy", subdir: "ream-legacy/_bmad-output" },
	{ tier: "flat", subdir: ".bmad" },
];

export function resolveBmadRoot(root: string): ResolveResult | null {
	const candidates: Candidate[] = [];

	const reamrcPath = readReamrcBmadRoot(root);
	const reamrcResolved = reamrcPath !== null ? toAbs(root, reamrcPath) : null;
	// Reject reamrc paths that escape `root` — reamrc.ts is part of the
	// committed project config, so a `bmadRoot` pointing to `../../etc`
	// is either a bug or an attempt to abuse `bmad.update_status`.
	const reamrcContained =
		reamrcResolved !== null && isContained(root, reamrcResolved);
	candidates.push({
		tier: "reamrc",
		path: reamrcResolved ?? "",
		exists:
			reamrcContained && reamrcResolved !== null && existsSync(reamrcResolved),
	});

	const envValue = process.env.REAM_BMAD_ROOT;
	const envResolved =
		typeof envValue === "string" && envValue.length > 0
			? toAbs(root, envValue)
			: null;
	candidates.push({
		tier: "env",
		path: envResolved ?? "",
		exists: envResolved !== null && existsSync(envResolved),
	});

	for (const { tier, subdir } of TIERS) {
		const path = subdir !== null ? join(root, subdir) : root;
		candidates.push({
			tier,
			path: forwardSlash(path),
			exists: existsSync(path),
		});
	}

	for (const candidate of candidates) {
		if (candidate.exists && candidate.path.length > 0) {
			return {
				root: forwardSlash(candidate.path),
				tier: candidate.tier,
				candidates: candidates.map((c) => ({
					tier: c.tier,
					path: forwardSlash(c.path),
					exists: c.exists,
				})),
			};
		}
	}

	return null;
}

/**
 * Read the optional `bmadRoot` field from `<root>/reamrc.ts`.
 * Resolves env-var refs (`env("VAR", "default")`) before falling
 * back to the literal evaluation. Returns the raw path string
 * (relative or absolute) when found, `null` otherwise.
 */
function readReamrcBmadRoot(root: string): string | null {
	const rcPath = join(root, "reamrc.ts");
	if (!existsSync(rcPath)) return null;
	try {
		const project = new Project({
			skipFileDependencyResolution: true,
			useInMemoryFileSystem: false,
		});
		project.addSourceFileAtPath(rcPath);
		const sf = project.getSourceFile(rcPath);
		if (!sf) return null;
		const exported = sf.getExportedDeclarations().get("default");
		if (!exported || exported.length === 0) return null;
		const decl = exported[0];
		const objLit = unwrapToObjectLiteral(decl);
		if (!objLit) return null;
		const prop = objLit.getProperty("bmadRoot");
		if (!prop || !Node.isPropertyAssignment(prop)) return null;
		const init = prop.getInitializer();
		if (!init) return null;

		const envRef = extractEnvRef(init);
		if (envRef) {
			const fromEnv = process.env[envRef.env];
			if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
			if (typeof envRef.default === "string") return envRef.default;
			return null;
		}
		const literal = evaluateLiteral(init);
		return typeof literal === "string" ? literal : null;
	} catch {
		return null;
	}
}

function unwrapToObjectLiteral(
	decl: Node,
): import("ts-morph").ObjectLiteralExpression | null {
	if (Node.isObjectLiteralExpression(decl)) return decl;
	if (Node.isCallExpression(decl)) {
		const arg = decl.getArguments()[0];
		if (arg && Node.isObjectLiteralExpression(arg)) return arg;
	}
	if (Node.isVariableDeclaration(decl)) {
		const init = decl.getInitializer();
		if (init) return unwrapToObjectLiteral(init);
	}
	if (Node.isExportAssignment(decl)) {
		return unwrapToObjectLiteral(decl.getExpression());
	}
	if (Node.isSatisfiesExpression(decl) || Node.isAsExpression(decl)) {
		return unwrapToObjectLiteral(decl.getExpression());
	}
	const inner = decl.getFirstDescendantByKind(
		SyntaxKind.ObjectLiteralExpression,
	);
	return inner ?? null;
}

function toAbs(root: string, p: string): string {
	if (isAbsolute(p)) return p;
	return join(root, p);
}

function isContained(root: string, candidate: string): boolean {
	const normRoot = resolve(root);
	const normCand = resolve(candidate);
	return normCand === normRoot || normCand.startsWith(normRoot + sep);
}

function forwardSlash(p: string): string {
	return p.replace(/\\/g, "/");
}
