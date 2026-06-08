/**
 * `docs.*` MCP tools — Story 33.2.
 *
 * Five tools registered on a single `Server` via
 * `setRequestHandler(CallToolRequestSchema, …)`. Each tool calls
 * into the Rust core (`@c9up/ream-mcp/napi`) and shapes the JSON
 * result for the LLM client.
 *
 * Stdio MCP servers must NOT write to stdout — observability for
 * indexing timing, sqlite-vec status, etc. goes to stderr.
 */

import { core } from "../../index.js";
import { indexReady } from "../util/startup-reindex.js";
import {
	findSymbol,
	isLoadError,
	loadProject,
} from "../util/ts-static-parser.js";

import { DOCS_TOOLS } from "./docs.descriptors.js";

export { DOCS_TOOLS };

interface ImplSite {
	file: string;
	line: number;
}

export function isDocsTool(name: string): boolean {
	return DOCS_TOOLS.some((t) => t.name === name);
}

/**
 * Pure dispatcher for `docs.*` tools. The server's combined
 * request handler calls this after deciding the tool belongs here.
 *
 * Audit 2026-05-22 F2: now async + awaits `indexReady`. The startup
 * reindex runs in the background so `initialize` and `tools/list`
 * respond instantly; index-dependent tools (search / get / explain /
 * audit_drift) must wait for the corpus to be ready before calling
 * into Rust. `indexReady` always resolves (failures log to stderr
 * but never reject), so callers can await it unconditionally.
 */
export async function dispatchDocs(
	root: string,
	name: string,
	args: Record<string, unknown> = {},
): Promise<unknown> {
	await indexReady;
	switch (name) {
		case "docs.search":
			return handleSearch(root, args);
		case "docs.get":
			return handleGet(root, args);
		case "docs.explain":
			return handleExplain(root, args);
		case "docs.trace":
			return handleTrace(root, args);
		case "docs.audit_drift":
			return handleAuditDrift(root);
		default:
			throw new Error(`Unknown docs tool: ${name}`);
	}
}

function handleSearch(root: string, args: Record<string, unknown>) {
	const query = requireString(args, "query");
	const opts: Record<string, unknown> = {};
	if (typeof args.package === "string") opts.package = args.package;
	if (typeof args.type === "string") opts.type = args.type;
	if (typeof args.limit === "number") opts.limit = args.limit;
	const json = core.search(root, query, JSON.stringify(opts));
	return JSON.parse(json);
}

function handleGet(root: string, args: Record<string, unknown>) {
	const id = typeof args.id === "string" ? args.id : null;
	const topic = typeof args.topic === "string" ? args.topic : null;
	if (!id && !topic) {
		throw new Error("docs.get: provide either `id` or `topic`.");
	}
	const json = core.getChunk(root, (id ?? topic) as string, id == null);
	if (json == null) return null;
	return JSON.parse(json);
}

function handleExplain(root: string, args: Record<string, unknown>) {
	const symbol = typeof args.symbol === "string" ? args.symbol : null;
	const file = typeof args.file === "string" ? args.file : null;
	const query = symbol ?? file;
	if (!query) {
		throw new Error("docs.explain: provide either `symbol` or `file`.");
	}
	// Story 33.3: try ts-morph symbol lookup first when caller passed
	// `symbol`. Falls through to BM25 on miss so `file` queries and
	// JSDoc-only matches still work.
	if (symbol) {
		const loaded = loadProject(root);
		if (!isLoadError(loaded)) {
			const site = findSymbol(loaded.project, symbol);
			if (site) {
				return {
					symbol: site.name,
					kind: site.kind,
					source: { file: site.file, lines: [site.line, site.line] },
					signature: site.signature,
					confidence: "high" as const,
					knownGaps: [],
				};
			}
		}
	}
	const opts = { type: "Code" };
	const json = core.search(root, query, JSON.stringify(opts));
	const result = JSON.parse(json) as { hits: unknown[] };
	return result;
}

function handleTrace(root: string, args: Record<string, unknown>) {
	const requirementId = requireString(args, "requirement_id");
	const sitesJson = core.trace(root, requirementId);
	const sites: ImplSite[] = JSON.parse(sitesJson);
	const implementations = sites.filter((s) => !s.file.includes("/tests/"));
	const tests = sites.filter((s) => s.file.includes("/tests/"));
	return {
		requirement: requirementId,
		implementations,
		tests,
		gaps: implementations.length === 0 ? [requirementId] : [],
	};
}

function handleAuditDrift(root: string) {
	const json = core.auditDrift(root);
	const drifted = JSON.parse(json);
	return { drifted };
}

function requireString(args: Record<string, unknown>, key: string): string {
	const v = args[key];
	if (typeof v !== "string" || v.length === 0) {
		throw new Error(`Missing or empty '${key}' (string required).`);
	}
	return v;
}
