/**
 * Lightweight tool-list descriptors for `docs.*` (Story 33.2).
 *
 * Kept separate from `docs.ts` so `server.ts` can answer
 * `tools/list` without statically loading ts-morph (used by
 * `docs.explain`'s symbol fallback in 33.3). The actual handlers
 * are dynamic-imported on first dispatch.
 */

interface ToolDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export const DOCS_TOOLS: ToolDescriptor[] = [
	{
		name: "docs.search",
		description:
			"Hybrid BM25 + cosine search over the indexed Ream docs corpus. Returns ranked chunks with source file/line refs and a confidence label.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Free-form text query." },
				package: {
					type: "string",
					description:
						"Optional filter — restrict to chunks under packages/<name>/.",
				},
				type: {
					type: "string",
					enum: ["Markdown", "Readme", "Adr", "Bmad", "Code"],
					description: "Optional filter by chunk kind.",
				},
				limit: {
					type: "number",
					minimum: 1,
					maximum: 50,
					description: "Max hits (default 10, hard cap 50).",
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
	{
		name: "docs.get",
		description:
			"Retrieve a single chunk by stable id (default) or top-1 BM25 hit on heading-path (when `topic` is provided).",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Stable chunk id." },
				topic: {
					type: "string",
					description: "Heading-path query for top-1 BM25 lookup.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "docs.explain",
		description:
			"Symbol explanation. Tries ts-morph symbol lookup first (returns the declaration site + signature when matched); falls back to a BM25 search restricted to `Code` chunks otherwise.",
		inputSchema: {
			type: "object",
			properties: {
				symbol: { type: "string", description: "Symbol name to explain." },
				file: {
					type: "string",
					description: "Optional file path hint.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "docs.trace",
		description:
			"Walk `@implements` annotations across packages/**/*.ts and return implementations, tests, and gaps for a requirement id (FR / MISS- / Story / Epic).",
		inputSchema: {
			type: "object",
			properties: {
				requirement_id: {
					type: "string",
					description: "e.g. `FR37`, `MISS-24`, `Story 32.7`, `Epic 36`.",
				},
			},
			required: ["requirement_id"],
			additionalProperties: false,
		},
	},
	{
		name: "docs.audit_drift",
		description:
			"Return tracked files whose source mtime is newer than the last indexed time (signaling stale documentation).",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
];
