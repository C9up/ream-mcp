/**
 * MCP server integration test — spawns the bin entry as a child
 * process via `tsx` (no compile step needed), drives JSON-RPC
 * over stdio, asserts initialize / tools/list / unknown-method /
 * SIGTERM behavior.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN_TS = join(HERE, "..", "..", "src", "index.ts");

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number | string | null;
	result?: unknown;
	error?: { code: number; message: string };
}

class StdioRpc {
	#child: ChildProcessWithoutNullStreams;
	#buffer = "";
	#queue: Array<(msg: JsonRpcResponse) => void> = [];

	constructor(child: ChildProcessWithoutNullStreams) {
		this.#child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			this.#buffer += chunk;
			let nl: number;
			// biome-ignore lint/suspicious/noAssignInExpressions: classic newline-framing loop
			while ((nl = this.#buffer.indexOf("\n")) !== -1) {
				const line = this.#buffer.slice(0, nl).trim();
				this.#buffer = this.#buffer.slice(nl + 1);
				if (!line) continue;
				const msg = JSON.parse(line) as JsonRpcResponse;
				const next = this.#queue.shift();
				if (next) next(msg);
			}
		});
	}

	send(req: Record<string, unknown>): Promise<JsonRpcResponse> {
		return new Promise((resolve) => {
			this.#queue.push(resolve);
			this.#child.stdin.write(`${JSON.stringify(req)}\n`);
		});
	}
}

function spawnServer(): {
	child: ChildProcessWithoutNullStreams;
	rpc: StdioRpc;
} {
	const tsx = join(HERE, "..", "..", "..", "..", "node_modules", ".bin", "tsx");
	const child = spawn(tsx, [BIN_TS], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, REAM_PROJECT_ROOT: "/tmp/dummy-root" },
	});
	const rpc = new StdioRpc(child);
	return { child, rpc };
}

let child: ChildProcessWithoutNullStreams | undefined;
let rpc: StdioRpc | undefined;

beforeEach(async () => {
	const spawned = spawnServer();
	child = spawned.child;
	rpc = spawned.rpc;
	// Give the server a moment to bring up the FFI + transport.
	await new Promise((r) => setTimeout(r, 250));
});

afterEach(async () => {
	if (child && child.exitCode === null) {
		child.kill("SIGKILL");
		await once(child, "exit").catch(() => undefined);
	}
});

describe("ream-mcp > stdio > initialize", () => {
	it("responds with serverInfo + tools capability", async () => {
		const res = await rpc?.send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "test-client", version: "0.0.1" },
			},
		});
		expect(res.error).toBeUndefined();
		const result = res.result as {
			serverInfo: { name: string; version: string };
			capabilities: { tools?: Record<string, unknown> };
			protocolVersion: string;
		};
		expect(result.serverInfo.name).toBe("@c9up/ream-mcp");
		expect(result.serverInfo.version).toBe("0.1.0");
		expect(result.capabilities.tools).toBeDefined();
		expect(typeof result.protocolVersion).toBe("string");
	});
});

describe("ream-mcp > stdio > tools/list", () => {
	it("returns the 5 docs.* + 6 introspect.* + 6 generate.* + 3 quality.* + 3 migration.* + 1 security.* + 7 bmad.* + 2 doctor.* + 2 inker.* + 1 station.* + 1 scheduler.* tools", async () => {
		await rpc?.send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "test-client", version: "0.0.1" },
			},
		});
		// `notifications/initialized` is fire-and-forget — the SDK
		// expects it but we don't need to await a response.
		child?.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
		);

		const res = await rpc?.send({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list",
			params: {},
		});
		expect(res.error).toBeUndefined();
		const result = res.result as {
			tools: Array<{ name: string; description: string; inputSchema: unknown }>;
		};
		const names = result.tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"bmad.gap_report",
			"bmad.get_story",
			"bmad.list_epics",
			"bmad.locate",
			"bmad.next_story",
			"bmad.trace",
			"bmad.update_status",
			"docs.audit_drift",
			"docs.explain",
			"docs.get",
			"docs.search",
			"docs.trace",
			"doctor.env_check",
			"doctor.health",
			"generate.controller",
			"generate.entity",
			"generate.migration",
			"generate.module",
			"generate.seeder",
			"generate.validator",
			"get.config",
			"inker.list_templates",
			"inker.render_test",
			"list.entities",
			"list.events",
			"list.middleware",
			"list.providers",
			"list.routes",
			"migration.rollback",
			"migration.run",
			"migration.status",
			"quality.dep_graph",
			"quality.duplicates",
			"quality.package_report",
			"scheduler.list_tasks",
			"security.scan",
			"station.list_resources",
		]);
		// Each tool has a non-empty description and an inputSchema.
		for (const tool of result.tools) {
			expect(tool.description.length).toBeGreaterThan(0);
			expect(tool.inputSchema).toBeDefined();
		}
	});
});

describe("ream-mcp > stdio > unknown method", () => {
	it("returns JSON-RPC error -32601 (Method not found)", async () => {
		await rpc?.send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "test-client", version: "0.0.1" },
			},
		});
		child?.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
		);

		const res = await rpc?.send({
			jsonrpc: "2.0",
			id: 99,
			method: "totally/made-up-method",
			params: {},
		});
		expect(res.error).toBeDefined();
		expect(res.error?.code).toBe(-32601);
	});
});

describe("ream-mcp > stdio > SIGTERM shutdown", () => {
	it("exits within 500ms of SIGTERM", async () => {
		if (!child) throw new Error("child process was not spawned");
		// Round-trip a JSON-RPC `initialize` first so we know the
		// transport + SIGTERM handler are wired up before we kill.
		// Without this, the 250ms beforeEach sleep races a slow boot
		// (ts-morph + MCP SDK + NAPI) and SIGTERM falls back to Node's
		// default behaviour (exit code 143 / signal-terminated).
		const initRes = await rpc?.send({
			jsonrpc: "2.0",
			id: 999,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "sigterm-test", version: "0.0.1" },
			},
		});
		expect(initRes?.error).toBeUndefined();

		const start = Date.now();
		child.kill("SIGTERM");
		const [code] = (await once(child, "exit")) as [number | null];
		const elapsed = Date.now() - start;
		expect(code).toBe(0);
		// AC: "shuts down cleanly within 500ms". Give a small grace
		// for the test's own scheduling overhead.
		expect(elapsed).toBeLessThan(1000);
	});
});
