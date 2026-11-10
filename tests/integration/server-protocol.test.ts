/**
 * The server as an MCP client sees it, over an in-memory transport: what
 * `tools/list` advertises and how `tools/call` reports failures.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";

import { registerAllTools } from "../../src/server.js";
import { startStartupReindex } from "../../src/util/startup-reindex.js";

let client: Client;
let server: Server;

beforeEach(async () => {
	server = new Server(
		{ name: "ream-mcp-test", version: "0.0.0" },
		{ capabilities: { tools: {} } },
	);
	registerAllTools(server);
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterEach(async () => {
	await client.close();
	await server.close();
});

describe("tools/list annotations", () => {
	it("annotates every tool", async () => {
		const { tools } = await client.listTools();
		for (const tool of tools) {
			expect(tool.annotations, tool.name).toBeDefined();
		}
	});

	it("marks the write tools destructive and never read-only", async () => {
		const { tools } = await client.listTools();
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
		// Creates its tracking table on first call: not read-only, only additive.
		const status = byName.get("migration.status")?.annotations;
		expect(status?.readOnlyHint).toBe(false);
		expect(status?.destructiveHint).toBe(false);
	});

	it("marks the inspection tools read-only", async () => {
		const { tools } = await client.listTools();
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
		]) {
			expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
		}
	});

	it("no longer advertises caller-side production flags", async () => {
		const { tools } = await client.listTools();
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
		rmSync(project, { recursive: true, force: true });
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
		const call = within(client.callTool({ name: "no.such.tool" }), 3000);
		await expect(call).rejects.toBeInstanceOf(McpError);
		await call.catch((err: unknown) => {
			expect(err instanceof McpError ? err.code : undefined).toBe(-32602);
			expect(err instanceof Error ? err.message : "").toContain(
				"Unknown tool: no.such.tool",
			);
		});
	});

	it("reports a thrown failure without stack frames or absolute paths", async () => {
		const result = await within(
			client.callTool({
				name: "docs.search",
				arguments: { query: "x", limit: -1 },
			}),
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
			const result = await within(
				client.callTool({ name, arguments: args }),
				10_000,
			);
			expect(result.isError, name).toBe(true);
			expect(text(result), name).toContain('"error"');
		}
	});

	it("leaves a successful result unflagged", async () => {
		const result = await within(
			client.callTool({ name: "migration.status", arguments: {} }),
			10_000,
		);
		expect(result.isError).toBeFalsy();
	});
});
