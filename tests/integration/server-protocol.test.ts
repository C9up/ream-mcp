/**
 * The server as an MCP client sees it, over an in-memory transport: what
 * `tools/list` advertises and how `tools/call` reports failures.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAllTools } from "../../src/server.js";

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
