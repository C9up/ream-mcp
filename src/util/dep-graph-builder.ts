/**
 * Internal dependency graph builder.
 *
 * Story 33.5 — `quality.dep_graph` MCP tool. Walks every TS source
 * file's `import` and `export ... from` declarations and resolves
 * specifiers to internal nodes (workspace packages or files).
 * External npm packages are deliberately NOT nodes — the graph is
 * about INTERNAL coupling.
 *
 * Cycles are computed via an iterative Tarjan's SCC algorithm
 * (recursive variant blew the stack on long file-scope chains)
 * and always present in the output (empty when acyclic).
 * Determinism: nodes and edges are sorted by lexicographic id;
 * cycles are emitted with their lex-smallest member rotated to
 * the front.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as pathResolve, relative } from "node:path";
import type { Project, SourceFile } from "ts-morph";

import type { WorkspacePackage } from "./package-walker.js";
import { eachSourceFile } from "./ts-static-parser.js";

const COVERAGE_MAX_BYTES = 1_048_576; // 1 MB

export type DepScope = "package" | "file";

export interface DepNode {
	id: string;
	kind: DepScope;
}

export interface DepEdge {
	from: string;
	to: string;
	weight: number;
}

export interface DepGraph {
	nodes: DepNode[];
	edges: DepEdge[];
	cycles: string[][];
}

export function buildDepGraph(
	project: Project,
	root: string,
	scope: DepScope,
	packages: WorkspacePackage[],
): DepGraph {
	const byName = new Map<string, WorkspacePackage>();
	for (const p of packages) byName.set(p.name, p);

	const fileToPackage = (filePath: string): string | null => {
		let best: WorkspacePackage | null = null;
		for (const p of packages) {
			if (
				filePath === p.dir ||
				filePath.startsWith(`${p.dir}/`) ||
				filePath.startsWith(`${p.dir}\\`)
			) {
				if (!best || p.dir.length > best.dir.length) best = p;
			}
		}
		return best?.name ?? null;
	};

	// Per-dispatch memoization for `existsSync` — the resolver tries
	// up to 11 candidate paths per relative import; without caching,
	// a 5k-file workspace generates tens of thousands of stat calls.
	const existsCache = new Map<string, boolean>();
	const existsMemo = (p: string): boolean => {
		const cached = existsCache.get(p);
		if (cached !== undefined) return cached;
		const result = existsSync(p);
		existsCache.set(p, result);
		return result;
	};

	const nodeIds = new Set<string>();
	const edgeMap = new Map<string, Map<string, number>>();
	// Both scopes now dedupe by (from, to, importerFile) so duplicate
	// imports from the same file collapse to weight 1; file scope
	// further caps weight at 1 per spec AC.
	const edgeImporters = new Map<string, Set<string>>();

	eachSourceFile(project, (sf) => {
		const importerPath = sf.getFilePath();
		const fromId =
			scope === "file"
				? toForwardSlash(relative(root, importerPath))
				: fileToPackage(importerPath);
		if (!fromId) return;
		nodeIds.add(fromId);

		const specs = collectSpecifiers(sf);
		for (const spec of specs) {
			// Type-only imports describe TYPE coupling, not runtime
			// coupling — exclude from the dep graph (they erase at
			// build time and shouldn't appear in cycles).
			if (spec.isTypeOnly) continue;
			const targetPath = resolveSpecifier(
				spec,
				importerPath,
				byName,
				existsMemo,
			);
			if (!targetPath) continue;
			const toId =
				scope === "file"
					? toForwardSlash(relative(root, targetPath))
					: fileToPackage(targetPath);
			if (!toId) continue;
			if (toId === fromId && scope === "package") {
				// Intra-package self-edges are noise — every internal
				// import would otherwise count as a self-loop cycle.
				// At file scope a real `import "./self.js"` is a bug
				// worth surfacing, so we KEEP it.
				continue;
			}
			nodeIds.add(toId);

			const key = `${fromId}\0${toId}`;
			const importers = edgeImporters.get(key);
			if (importers) {
				if (importers.has(importerPath)) continue;
				importers.add(importerPath);
			} else {
				edgeImporters.set(key, new Set([importerPath]));
			}
			incEdge(edgeMap, fromId, toId);
		}
	});

	const nodes: DepNode[] = [...nodeIds]
		.sort((a, b) => a.localeCompare(b))
		.map((id) => ({ id, kind: scope }));

	const edges: DepEdge[] = [];
	for (const [from, targets] of edgeMap) {
		for (const [to, weight] of targets) {
			// File scope: weight is always 1 per AC; at package scope
			// it reflects the count of distinct importer files.
			edges.push({ from, to, weight: scope === "file" ? 1 : weight });
		}
	}
	edges.sort((a, b) =>
		a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from),
	);

	const cycles = tarjanSccs(
		nodes.map((n) => n.id),
		edges,
	);

	return { nodes, edges, cycles };
}

function incEdge(
	edgeMap: Map<string, Map<string, number>>,
	from: string,
	to: string,
): void {
	const inner = edgeMap.get(from);
	if (inner) {
		inner.set(to, (inner.get(to) ?? 0) + 1);
	} else {
		edgeMap.set(from, new Map([[to, 1]]));
	}
}

interface ImportSpecifier {
	specifier: string;
	isTypeOnly: boolean;
}

function collectSpecifiers(sf: SourceFile): ImportSpecifier[] {
	const out: ImportSpecifier[] = [];
	for (const decl of sf.getImportDeclarations()) {
		out.push({
			specifier: decl.getModuleSpecifierValue(),
			isTypeOnly: decl.isTypeOnly(),
		});
	}
	for (const decl of sf.getExportDeclarations()) {
		const spec = decl.getModuleSpecifierValue();
		if (spec) out.push({ specifier: spec, isTypeOnly: decl.isTypeOnly() });
	}
	return out;
}

/**
 * Resolve a module specifier to an absolute file path. Returns
 * null for external specifiers (npm packages not in the
 * workspace), for relative paths that point at non-existent
 * files, and for sub-path imports inside a workspace package
 * that don't physically resolve (no fall-through to the
 * package's main entry — that produced phantom edges).
 */
function resolveSpecifier(
	spec: ImportSpecifier,
	importerPath: string,
	byName: Map<string, WorkspacePackage>,
	exists: (p: string) => boolean,
): string | null {
	const s = spec.specifier;
	if (s.startsWith(".")) {
		const importerDir = dirname(importerPath);
		const base = pathResolve(importerDir, s);
		// TS NodeNext convention: `./foo.js` source-resolves to
		// `./foo.ts`. Pre-compute the de-extensioned base so the
		// `.js`/`.cjs`/`.mjs` → `.ts`/`.cts`/`.mts` swap is one of
		// the candidates.
		const baseNoExt = base.replace(/\.(?:js|mjs|cjs)$/, "");
		const candidates = [
			base,
			`${base}.ts`,
			`${base}.tsx`,
			`${base}.js`,
			`${base}.mjs`,
			`${baseNoExt}.ts`,
			`${baseNoExt}.tsx`,
			`${baseNoExt}.mts`,
			`${baseNoExt}.cts`,
			join(base, "index.ts"),
			join(base, "index.tsx"),
			join(base, "index.js"),
		];
		for (const c of candidates) {
			if (exists(c)) return c;
		}
		return null;
	}
	const segments = s.split("/");
	const pkgName = s.startsWith("@")
		? `${segments[0]}/${segments[1] ?? ""}`
		: segments[0];
	const pkg = byName.get(pkgName);
	if (!pkg) return null;
	if (segments.length === (s.startsWith("@") ? 2 : 1)) {
		return pkg.mainEntry;
	}
	const subRel = segments.slice(s.startsWith("@") ? 2 : 1).join("/");
	// Mirror the relative-import resolution list (NodeNext `.js`/`.mjs`/
	// `.cjs` → `.ts`/`.mts`/`.cts` swap + `.tsx` for UI sub-paths).
	// Previously this branch tested only `.ts` and `index.ts`, which
	// silently dropped edges to workspace packages exposing `.tsx` or
	// `.mts` sub-paths — underestimating cycles/couplings.
	const subRelNoExt = subRel.replace(/\.(?:js|mjs|cjs)$/, "");
	const candidates = [
		join(pkg.dir, "src", `${subRel}.ts`),
		join(pkg.dir, "src", `${subRel}.tsx`),
		join(pkg.dir, "src", `${subRelNoExt}.ts`),
		join(pkg.dir, "src", `${subRelNoExt}.tsx`),
		join(pkg.dir, "src", `${subRelNoExt}.mts`),
		join(pkg.dir, "src", `${subRelNoExt}.cts`),
		join(pkg.dir, "src", subRel, "index.ts"),
		join(pkg.dir, "src", subRel, "index.tsx"),
		join(pkg.dir, `${subRel}.ts`),
		join(pkg.dir, `${subRel}.tsx`),
		join(pkg.dir, `${subRelNoExt}.ts`),
		join(pkg.dir, `${subRelNoExt}.tsx`),
		join(pkg.dir, `${subRelNoExt}.mts`),
		join(pkg.dir, `${subRelNoExt}.cts`),
		join(pkg.dir, subRel, "index.ts"),
		join(pkg.dir, subRel, "index.tsx"),
	];
	for (const c of candidates) {
		if (exists(c)) return c;
	}
	// No fallback to pkg.mainEntry — an unresolvable sub-path was
	// producing phantom edges to the package entry, inflating
	// in-degree and creating false cycles.
	return null;
}

/**
 * Iterative Tarjan's strongly-connected-components. Returns
 * every SCC of size ≥ 2 (true cycles) plus singleton SCCs that
 * have a self-loop. Each cycle is rotated so its
 * lexicographically smallest member is the first element.
 */
function tarjanSccs(nodes: string[], edges: DepEdge[]): string[][] {
	const adj = new Map<string, string[]>();
	for (const n of nodes) adj.set(n, []);
	for (const e of edges) {
		const list = adj.get(e.from);
		if (list) list.push(e.to);
	}

	let index = 0;
	const indices = new Map<string, number>();
	const lowlinks = new Map<string, number>();
	const onStack = new Set<string>();
	const tarjanStack: string[] = [];
	const sccs: string[][] = [];

	// Each work-frame tracks the node and where we are in its
	// neighbor list (the equivalent of a recursive call's program
	// counter). When we recurse, we push a new frame; when we
	// return, we pop and update the parent's lowlink.
	interface Frame {
		v: string;
		neighbors: string[];
		nIdx: number;
	}

	for (const start of nodes) {
		if (indices.has(start)) continue;
		const stack: Frame[] = [];
		indices.set(start, index);
		lowlinks.set(start, index);
		index += 1;
		tarjanStack.push(start);
		onStack.add(start);
		stack.push({ v: start, neighbors: adj.get(start) ?? [], nIdx: 0 });

		while (stack.length > 0) {
			const frame = stack[stack.length - 1];
			if (frame.nIdx < frame.neighbors.length) {
				const w = frame.neighbors[frame.nIdx];
				frame.nIdx += 1;
				if (!indices.has(w)) {
					indices.set(w, index);
					lowlinks.set(w, index);
					index += 1;
					tarjanStack.push(w);
					onStack.add(w);
					stack.push({ v: w, neighbors: adj.get(w) ?? [], nIdx: 0 });
				} else if (onStack.has(w)) {
					const cur = lowlinks.get(frame.v) ?? Number.POSITIVE_INFINITY;
					const wIdx = indices.get(w) ?? Number.POSITIVE_INFINITY;
					if (wIdx < cur) lowlinks.set(frame.v, wIdx);
				}
				continue;
			}
			// All neighbors visited — pop this frame and bubble its
			// lowlink up to the parent.
			stack.pop();
			const v = frame.v;
			const vLow = lowlinks.get(v) ?? Number.POSITIVE_INFINITY;
			const vIdx = indices.get(v) ?? Number.POSITIVE_INFINITY;
			if (vLow === vIdx) {
				const component: string[] = [];
				let popped: string | undefined;
				do {
					popped = tarjanStack.pop();
					if (popped === undefined) break;
					onStack.delete(popped);
					component.push(popped);
				} while (popped !== v);
				sccs.push(component);
			}
			if (stack.length > 0) {
				const parent = stack[stack.length - 1];
				const parentLow = lowlinks.get(parent.v) ?? Number.POSITIVE_INFINITY;
				if (vLow < parentLow) lowlinks.set(parent.v, vLow);
			}
		}
	}

	const cycles: string[][] = [];
	for (const c of sccs) {
		if (c.length >= 2) {
			cycles.push(rotateLex(c));
		} else if (c.length === 1) {
			const self = c[0];
			if ((adj.get(self) ?? []).includes(self)) {
				cycles.push([self]);
			}
		}
	}
	cycles.sort((a, b) => {
		if (a[0] !== b[0]) return a[0].localeCompare(b[0]);
		return a.length - b.length;
	});
	return cycles;
}

function rotateLex(cycle: string[]): string[] {
	let minIdx = 0;
	for (let i = 1; i < cycle.length; i++) {
		if (cycle[i].localeCompare(cycle[minIdx]) < 0) minIdx = i;
	}
	return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
}

/**
 * Render the graph as Graphviz `digraph { … }`. Edges that
 * connect two nodes within the same cycle (SCC) are styled
 * `color="red"` — we use the membership test against each cycle's
 * node set, NOT the rotated ring (the rotation is for display
 * order and isn't guaranteed to match a real graph edge).
 */
export function toDot(graph: DepGraph): string {
	const cycleMembership = new Map<string, Set<string>>();
	for (const cycle of graph.cycles) {
		const set = new Set(cycle);
		for (const id of cycle) cycleMembership.set(id, set);
	}
	const isCycleEdge = (from: string, to: string): boolean => {
		const fromSet = cycleMembership.get(from);
		if (!fromSet) return false;
		return fromSet.has(to);
	};

	const lines = ["digraph deps {", '  rankdir="LR";'];
	for (const n of graph.nodes) {
		lines.push(`  ${quote(n.id)};`);
	}
	for (const e of graph.edges) {
		const styled = isCycleEdge(e.from, e.to) ? ' [color="red"]' : "";
		lines.push(`  ${quote(e.from)} -> ${quote(e.to)}${styled};`);
	}
	lines.push("}");
	return lines.join("\n");
}

function quote(s: string): string {
	return `"${s.replace(/"/g, '\\"')}"`;
}

function toForwardSlash(p: string): string {
	return p.replace(/\\/g, "/");
}

/**
 * Read a `coverage/coverage-summary.json` if it exists at the
 * given package directory, return its `total` block with
 * rounded percentages. Returns `null` for missing files,
 * unreadable files, files larger than 1 MB, malformed JSON, or
 * any pct that's missing/non-finite (don't fabricate a fake 0%).
 */
export interface CoverageBlock {
	lines: number;
	branches: number;
	functions: number;
	statements: number;
}

export function readCoverageSummary(pkgDir: string): CoverageBlock | null {
	const summaryPath = join(pkgDir, "coverage", "coverage-summary.json");
	let size: number;
	try {
		const stat = statSync(summaryPath);
		if (!stat.isFile()) return null;
		size = stat.size;
	} catch {
		return null;
	}
	if (size > COVERAGE_MAX_BYTES) return null;
	try {
		const raw = JSON.parse(readFileSync(summaryPath, "utf8")) as {
			total?: {
				lines?: { pct?: number };
				branches?: { pct?: number };
				functions?: { pct?: number };
				statements?: { pct?: number };
			};
		};
		const t = raw.total;
		if (!t) return null;
		const lines = pickPct(t.lines?.pct);
		const branches = pickPct(t.branches?.pct);
		const functions = pickPct(t.functions?.pct);
		const statements = pickPct(t.statements?.pct);
		if (
			lines === null ||
			branches === null ||
			functions === null ||
			statements === null
		) {
			return null;
		}
		return { lines, branches, functions, statements };
	} catch {
		return null;
	}
}

function pickPct(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.round(value * 10) / 10;
}
