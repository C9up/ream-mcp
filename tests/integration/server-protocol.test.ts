/**
 * The server as an MCP client sees it, over in-memory streams: what
 * `tools/list` advertises and how `tools/call` reports failures.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";

import { McpServer } from "../../src/protocol/server.js";
import { toolsHandlers } from "../../src/server.js";
import { startStartupReindex } from "../../src/util/startup-reindex.js";
import { TestClient } from "../protocol-client.js";
import { removeIndexedProject } from "../test-utils.js";

let client: TestClient;
let server: McpServer;

interface ListedTool {
	name: string;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
	inputSchema?: { properties?: Record<string, unknown> };
}

function isListedTool(value: unknown): value is ListedTool {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		typeof value.name === "string"
	);
}

async function listTools(): Promise<ListedTool[]> {
	const reply = await client.request("tools/list", {});
	const tools = reply.result?.tools;
	if (!Array.isArray(tools)) throw new Error("tools/list returned no tools");
	return tools.filter(isListedTool);
}

async function callTool(
	name: string,
	args?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const reply = await client.request("tools/call", {
		name,
		...(args ? { arguments: args } : {}),
	});
	if (reply.error) {
		throw new Error(`${reply.error.code}: ${reply.error.message}`);
	}
	return reply.result ?? {};
}

beforeEach(async () => {
	server = new McpServer(
		{ name: "ream-mcp-test", version: "0.0.0" },
		toolsHandlers(),
	);
	client = new TestClient(server);
	await client.request("initialize", {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "test-client", version: "0.0.0" },
	});
	client.notify("notifications/initialized");
});

afterEach(async () => {
	await server.close();
});

describe("tools/list annotations", () => {
	it("annotates every tool", async () => {
		const tools = await listTools();
		for (const tool of tools) {
			expect(tool.annotations, tool.name).toBeDefined();
		}
	});

	it("marks the write tools destructive and never read-only", async () => {
		const tools = await listTools();
		const byName = new Map(tools.map((t) => [t.name, t]));
		for (const name of [
			"migration.run",
			"migration.rollback",
			"bmad.update_status",
			"generate.module",
			"generate.migration",
		]) {
			const a = byName.get(name)?.annotations;
			expect(a?.readOnlyHint, name).toBe(false);
			expect(a?.destructiveHint, name).toBe(true);
		}
	});

	it("marks the inspection tools read-only", async () => {
		const tools = await listTools();
		const byName = new Map(tools.map((t) => [t.name, t]));
		for (const name of [
			"list.routes",
			"get.config",
			"docs.search",
			"security.scan",
			"doctor.health",
			"bmad.trace",
			"inker.list_templates",
			"quality.dep_graph",
			// Never creates the tracking table: a status read changes nothing.
			"migration.status",
		]) {
			expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
		}
	});

	it("no longer advertises caller-side production flags", async () => {
		const tools = await listTools();
		for (const name of ["migration.run", "migration.rollback"]) {
			const schema = tools.find((t) => t.name === name)?.inputSchema;
			const props = Object.keys(schema?.properties ?? {});
			expect(props, name).not.toContain("env");
			expect(props, name).not.toContain("allowProduction");
		}
	});
});

describe("tools/call failures", () => {
	let project: string;
	const saved = new Map<string, string | undefined>();
	const VARS = ["REAM_PROJECT_ROOT", "REAM_DATABASE_URL", "DATABASE_URL"];

	beforeAll(() => {
		for (const v of VARS) saved.set(v, process.env[v]);
		project = mkdtempSync(join(tmpdir(), "server-protocol-"));
		writeFileSync(
			join(project, "package.json"),
			JSON.stringify({ name: "app", dependencies: { "@c9up/ream": "*" } }),
		);
		process.env.REAM_PROJECT_ROOT = project;
		process.env.REAM_DATABASE_URL = `sqlite://${join(project, "app.db")}`;
		delete process.env.DATABASE_URL;
		startStartupReindex();
	});

	afterAll(() => {
		for (const v of VARS) {
			const value = saved.get(v);
			if (value === undefined) delete process.env[v];
			else process.env[v] = value;
		}
		removeIndexedProject(project);
	});

	function text(result: unknown): string {
		const content =
			typeof result === "object" && result !== null && "content" in result
				? result.content
				: undefined;
		if (!Array.isArray(content)) return "";
		return content
			.map((c: unknown) =>
				typeof c === "object" && c !== null && "text" in c
					? String(c.text)
					: "",
			)
			.join("\n");
	}

	function within<T>(promise: Promise<T>, ms: number): Promise<T> {
		return Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
			}),
		]);
	}

	it("answers an unknown tool with a -32602 protocol error, at once", async () => {
		const reply = await within(
			client.request("tools/call", { name: "no.such.tool" }),
			3000,
		);
		expect(reply.error?.code).toBe(-32602);
		expect(reply.error?.message).toContain("Unknown tool: no.such.tool");
	});

	it("refuses arguments outside the tool's schema before the tool runs", async () => {
		const result = await within(
			callTool("docs.search", { query: "x", limit: -1, extra: true }),
			3000,
		);
		expect(result.isError).toBe(true);
		const body = JSON.parse(text(result));
		expect(body.error).toBe("invalid arguments for docs.search");
		expect(body.problems).toEqual([
			"limit must be >= 1",
			"extra is not an accepted argument",
		]);
	});

	it("refuses a missing required argument", async () => {
		const result = await within(callTool("docs.search", {}), 3000);
		expect(result.isError).toBe(true);
		expect(JSON.parse(text(result)).problems).toEqual(["query is required"]);
	});

	it("reports a thrown failure without stack frames or absolute paths", async () => {
		// The schema allows any number >= 1; the native side wants an integer,
		// so a fractional limit gets past validation and throws inside the tool.
		const result = await within(
			callTool("docs.search", { query: "x", limit: 1.5 }),
			10_000,
		);
		expect(result.isError).toBe(true);
		const body = text(result);
		expect(body).toContain("docs.search");
		expect(body).not.toMatch(/\n\s+at /);
		expect(body).not.toContain(process.cwd());
		expect(body).not.toMatch(/\/[^\s/]+\/[^\s/]+\.ts/);
	});

	it("flags a shaped refusal as a tool error", async () => {
		for (const [name, args] of [
			["migration.run", { dryRun: false }],
			["generate.controller", { name: "x" }],
		] as const) {
			const result = await within(callTool(name, args), 10_000);
			expect(result.isError, name).toBe(true);
			expect(text(result), name).toContain('"error"');
		}
	});

	it("leaves a successful result unflagged", async () => {
		const result = await within(callTool("migration.status", {}), 10_000);
		expect(result.isError).toBeFalsy();
	});
});
