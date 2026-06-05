/**
 * `quality.*` MCP tools — Story 33.5.
 *
 * Three read-only tools that turn quality signals into structured
 * JSON: `quality.duplicates`, `quality.package_report`,
 * `quality.dep_graph`. Every tool is in-process via ts-morph; no
 * shelling, no network.
 *
 * Same descriptor / handler split as 33.3 / 33.4: this file is
 * dynamic-imported on first dispatch via `server.ts::loadHandlers`
 * Promise.all so the cold-boot path stays under 250 ms.
 */

import { relative } from "node:path";
import type { SourceFile } from "ts-morph";

import {
	buildDepGraph,
	type DepGraph,
	type DepScope,
	readCoverageSummary,
	toDot,
} from "../util/dep-graph-builder.js";
import { findDuplicates } from "../util/dup-detector.js";
import {
	type WorkspacePackage,
	walkWorkspacePackages,
} from "../util/package-walker.js";
import {
	eachSourceFile,
	isLoadError,
	type LoadedProject,
	loadProject,
} from "../util/ts-static-parser.js";

export {
	isQualityTool,
	QUALITY_TOOLS,
} from "./quality.descriptors.js";

type Confidence = "high" | "medium" | "low";

export function dispatchQuality(
	root: string,
	name: string,
	args: Record<string, unknown> = {},
): unknown {
	const loaded = loadProject(root);
	if (isLoadError(loaded)) return shapeError(loaded.error, loaded.hint);

	switch (name) {
		case "quality.duplicates":
			return runDuplicates(loaded, root, args);
		case "quality.package_report":
			return runPackageReport(loaded, root, args);
		case "quality.dep_graph":
			return runDepGraph(loaded, root, args);
		default:
			return shapeError(`Unknown quality tool: ${name}`, "");
	}
}

function wrap<T extends Record<string, unknown>>(
	loaded: LoadedProject,
	root: string,
	body: T,
	extraGaps: string[] = [],
): T & { confidence: Confidence; knownGaps: string[] } {
	// Relativize parse-error paths so `knownGaps` matches the
	// forward-slash relative format used by the other quality
	// tools' skip lists.
	const parseGaps = loaded.parseErrors.map(
		(p) => `parse error in ${toForwardSlash(relative(root, p))}`,
	);
	const knownGaps = [...parseGaps, ...extraGaps];
	return {
		...body,
		confidence: knownGaps.length === 0 ? "high" : "medium",
		knownGaps,
	};
}

function shapeError(
	error: string,
	hint: string,
): {
	error: string;
	hint: string;
	confidence: Confidence;
	knownGaps: string[];
} {
	return { error, hint, confidence: "low", knownGaps: [] };
}

function toForwardSlash(p: string): string {
	return p.replace(/\\/g, "/");
}

// -------------------------------------------------------- duplicates

function runDuplicates(
	loaded: LoadedProject,
	root: string,
	args: Record<string, unknown>,
): unknown {
	const minTokens = positiveInt(args.minTokens, 20);
	if (minTokens === null)
		return shapeError(
			"invalid minTokens",
			"minTokens must be a positive integer.",
		);
	const minLines = positiveInt(args.minLines, 3);
	if (minLines === null)
		return shapeError(
			"invalid minLines",
			"minLines must be a positive integer.",
		);

	const result = findDuplicates(loaded.project, root, {
		minTokens,
		minLines,
	});
	return wrap(loaded, root, { duplicates: result.duplicates }, result.skipped);
}

function positiveInt(value: unknown, fallback: number): number | null {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		return null;
	}
	return value;
}

// ----------------------------------------------------- package_report

interface PackageRow {
	name: string;
	files: number;
	loc: number;
	publicExports: number;
	testCoverage?: {
		lines: number;
		branches: number;
		functions: number;
		statements: number;
	};
	lintIssues: number;
	circularDeps: number;
}

function runPackageReport(
	loaded: LoadedProject,
	root: string,
	args: Record<string, unknown>,
): unknown {
	const filter =
		typeof args.package === "string" && args.package.length > 0
			? args.package
			: null;

	const allPackages = walkWorkspacePackages(root);
	if (allPackages.length === 0) {
		return shapeError(
			"no workspace packages detected",
			"expected at least one `package.json` with a `name` and a resolvable entry under the project root",
		);
	}

	let selected: WorkspacePackage[] = allPackages;
	if (filter) {
		selected = allPackages.filter((p) => p.name === filter);
		if (selected.length === 0) {
			const known = allPackages.map((p) => p.name).join(", ");
			return shapeError(
				`no such package: ${filter}`,
				`known packages: ${known}`,
			);
		}
	}

	const graph = buildDepGraph(loaded.project, root, "package", allPackages);
	const cyclesPerPackage = countCyclesPerNode(graph);

	const extraGaps: string[] = [];
	const rows: PackageRow[] = [];
	for (const pkg of selected) {
		const stats = collectPackageStats(loaded, pkg);
		if (stats.entryMissing) {
			extraGaps.push(
				`entry file not loaded for ${pkg.name} (publicExports unknown)`,
			);
		}
		const coverage = readCoverageSummary(pkg.dir);
		// Missing coverage is the NORMAL state for fresh projects;
		// don't downgrade confidence over it. The absence of the
		// `testCoverage` block in the row is the signal.
		rows.push({
			name: pkg.name,
			files: stats.files,
			loc: stats.loc,
			publicExports: stats.publicExports,
			...(coverage ? { testCoverage: coverage } : {}),
			lintIssues: stats.lintIssues,
			circularDeps: cyclesPerPackage.get(pkg.name) ?? 0,
		});
	}

	rows.sort((a, b) => a.name.localeCompare(b.name));
	return wrap(loaded, root, { packages: rows }, extraGaps);
}

function countCyclesPerNode(graph: DepGraph): Map<string, number> {
	const counts = new Map<string, number>();
	for (const cycle of graph.cycles) {
		const seen = new Set<string>();
		for (const id of cycle) {
			if (seen.has(id)) continue;
			seen.add(id);
			counts.set(id, (counts.get(id) ?? 0) + 1);
		}
	}
	return counts;
}

interface PackageStats {
	files: number;
	loc: number;
	publicExports: number;
	lintIssues: number;
	entryMissing: boolean;
}

function collectPackageStats(
	loaded: LoadedProject,
	pkg: WorkspacePackage,
): PackageStats {
	let files = 0;
	let loc = 0;
	let lintIssues = 0;
	eachSourceFile(loaded.project, (sf) => {
		const filePath = sf.getFilePath();
		if (!isInsidePackage(filePath, pkg.dir)) return;
		if (isTestFile(filePath)) return;
		files += 1;
		try {
			loc += countLoc(sf);
		} catch {
			lintIssues += 1;
		}
	});
	const exports = countPublicExports(loaded, pkg);
	for (const errPath of loaded.parseErrors) {
		if (isInsidePackage(errPath, pkg.dir)) lintIssues += 1;
	}
	return {
		files,
		loc,
		publicExports: exports.count,
		lintIssues,
		entryMissing: exports.entryMissing,
	};
}

function isInsidePackage(filePath: string, pkgDir: string): boolean {
	const norm = toForwardSlash(filePath);
	const dir = toForwardSlash(pkgDir);
	return norm === dir || norm.startsWith(`${dir}/`);
}

/**
 * Match `*.test.*` and `*.spec.*` AND any path segment containing
 * a `__tests__/` directory — the latter is a common Jest/vitest
 * convention that the regex alone misses.
 */
function isTestFile(filePath: string): boolean {
	if (/\.(?:test|spec)\.[mc]?[jt]sx?$/.test(filePath)) return true;
	const norm = toForwardSlash(filePath);
	return norm.includes("/__tests__/");
}

function countLoc(sf: SourceFile): number {
	let count = 0;
	const lines = sf.getFullText().split("\n");
	let inBlockComment = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		if (inBlockComment) {
			const closeIdx = trimmed.indexOf("*/");
			if (closeIdx === -1) continue;
			inBlockComment = false;
			const after = trimmed.slice(closeIdx + 2).trim();
			if (after.length > 0 && !after.startsWith("//")) {
				count += 1;
			}
			continue;
		}
		if (trimmed.startsWith("//")) continue;
		if (trimmed.startsWith("/*")) {
			const closeIdx = trimmed.indexOf("*/");
			if (closeIdx === -1) {
				inBlockComment = true;
				continue;
			}
			// `/* note */ const x = 1;` — count the line if there's
			// real code after the inline comment. Was previously
			// silently dropping these.
			const after = trimmed.slice(closeIdx + 2).trim();
			if (after.length > 0 && !after.startsWith("//")) {
				count += 1;
			}
			continue;
		}
		count += 1;
	}
	return count;
}

interface PublicExportCount {
	count: number;
	entryMissing: boolean;
}

function countPublicExports(
	loaded: LoadedProject,
	pkg: WorkspacePackage,
): PublicExportCount {
	const entrySf = loaded.project.getSourceFile(pkg.mainEntry);
	if (!entrySf) return { count: 0, entryMissing: true };
	// Single Set of names so locally-declared exports and re-exports
	// don't double-count when both an `ExportDeclaration` and a
	// matching symbol exist.
	const names = new Set<string>();
	for (const decl of entrySf.getExportDeclarations()) {
		const named = decl.getNamedExports();
		if (named.length === 0) {
			// `export * from "./x.js"` — count the re-exported module
			// as a single anonymous export so the namespace itself is
			// represented exactly once.
			names.add(`*:${decl.getModuleSpecifierValue() ?? "?"}`);
		} else {
			for (const n of named) {
				names.add(n.getName());
			}
		}
	}
	for (const symbol of entrySf.getExportSymbols()) {
		names.add(symbol.getName());
	}
	return { count: names.size, entryMissing: false };
}

// --------------------------------------------------------- dep_graph

function runDepGraph(
	loaded: LoadedProject,
	root: string,
	args: Record<string, unknown>,
): unknown {
	const format = args.format ?? "json";
	if (format !== "json" && format !== "dot") {
		return shapeError(
			`invalid format: ${JSON.stringify(format)}`,
			'format must be "json" or "dot".',
		);
	}
	const scope = args.scope ?? "package";
	if (scope !== "package" && scope !== "file") {
		return shapeError(
			`invalid scope: ${JSON.stringify(scope)}`,
			'scope must be "package" or "file".',
		);
	}

	const packages = walkWorkspacePackages(root);
	const graph = buildDepGraph(
		loaded.project,
		root,
		scope as DepScope,
		packages,
	);

	if (format === "dot") {
		return wrap(loaded, root, {
			graph: toDot(graph),
			cycles: graph.cycles,
		});
	}
	return wrap(loaded, root, {
		nodes: graph.nodes,
		edges: graph.edges,
		cycles: graph.cycles,
	});
}
