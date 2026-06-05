/**
 * Lightweight tool-list descriptors for `quality.*` (Story 33.5).
 *
 * Same descriptor / handler split as 33.3 / 33.4: this file holds
 * the JSON schemas only and is statically imported by `server.ts`.
 * The heavy `quality.ts` dispatcher (which loads ts-morph) is
 * dynamic-imported on first call so the cold-boot path stays under
 * 250 ms (cerebrum: heavy CJS imports race SIGTERM).
 */

interface ToolDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export const QUALITY_TOOLS: ToolDescriptor[] = [
	{
		name: "quality.duplicates",
		description:
			'Token-stream rolling-hash duplicate detector across the project\'s TS sources. Identifier names are anonymized (function `foo` and `function bar` with identical bodies are duplicates); keywords, punctuation, and string/number literals are preserved (so `db.query("SELECT a")` and `db.query("SELECT b")` are NOT duplicates). Defaults are intentionally aggressive (minTokens=20, minLines=3) per Ream\'s no-duplication stance.',
		inputSchema: {
			type: "object",
			properties: {
				minTokens: {
					type: "integer",
					minimum: 1,
					default: 20,
					description:
						"Minimum length of a duplicated fragment in normalized tokens.",
				},
				minLines: {
					type: "integer",
					minimum: 1,
					default: 3,
					description: "Minimum number of source lines a duplicate must span.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "quality.package_report",
		description:
			"Per-package metrics: file count, LOC (excluding blank/comment-only lines), public-export count, lint-issue count (= ts-morph parse errors only — NOT biome/eslint), circular-dep participation count, optional testCoverage block from `coverage/coverage-summary.json`. When `package` is omitted, every workspace package is reported.",
		inputSchema: {
			type: "object",
			properties: {
				package: {
					type: "string",
					description:
						"Optional `name` field from a workspace `package.json`. When omitted, all packages are reported.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "quality.dep_graph",
		description:
			"Internal dependency graph as JSON edges or Graphviz `dot`. External npm packages are NOT nodes — the graph is for INTERNAL coupling. Cycles are computed via Tarjan's SCC algorithm and always present (empty when acyclic).",
		inputSchema: {
			type: "object",
			properties: {
				format: {
					type: "string",
					enum: ["json", "dot"],
					default: "json",
					description:
						"`json` returns nodes/edges/cycles; `dot` returns a Graphviz `digraph` ready for `dot -Tsvg`.",
				},
				scope: {
					type: "string",
					enum: ["package", "file"],
					default: "package",
					description:
						"`package` aggregates by workspace package directory; `file` produces one node per TS file.",
				},
			},
			additionalProperties: false,
		},
	},
];

const NAMES = new Set(QUALITY_TOOLS.map((t) => t.name));

export function isQualityTool(name: string): boolean {
	return NAMES.has(name);
}
