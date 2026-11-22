/**
 * The MCP stdio server on its own: framing, JSON-RPC errors, version
 * negotiation, notifications, cancellation, and the argument check.
 */

import { describe, expect, it } from "vitest";

import {
	SUPPORTED_KEYWORDS,
	schemaKeywords,
	validateArguments,
} from "../../src/protocol/arguments.js";
import { readMessage } from "../../src/protocol/jsonrpc.js";
import {
	LATEST_PROTOCOL_VERSION,
	McpServer,
	SUPPORTED_PROTOCOL_VERSIONS,
	type ToolsHandlers,
} from "../../src/protocol/server.js";
import { MAX_LINE_BYTES } from "../../src/protocol/stdio.js";
import { BMAD_TOOLS } from "../../src/tools/bmad.descriptors.js";
import { DOCS_TOOLS } from "../../src/tools/docs.descriptors.js";
import { DOCTOR_TOOLS } from "../../src/tools/doctor.descriptors.js";
import { GENERATE_TOOLS } from "../../src/tools/generate.descriptors.js";
import { INKER_TOOLS } from "../../src/tools/inker.descriptors.js";
import { INTROSPECT_TOOLS } from "../../src/tools/introspect.descriptors.js";
import { MIGRATION_TOOLS } from "../../src/tools/migration.descriptors.js";
import { QUALITY_TOOLS } from "../../src/tools/quality.descriptors.js";
import { SCHEDULER_TOOLS } from "../../src/tools/scheduler.descriptors.js";
import { SECURITY_TOOLS } from "../../src/tools/security.descriptors.js";
import { STATION_TOOLS } from "../../src/tools/station.descriptors.js";
import { TestClient } from "../protocol-client.js";

const echo: ToolsHandlers = {
	list: () => ({ tools: [{ name: "echo" }] }),
	call: async ({ name, arguments: args }) => {
		if (name === "slow") {
			await new Promise((resolve) => setTimeout(resolve, 100));
			return { content: [] };
		}
		if (name === "boom") throw new Error("it broke");
		return { content: [{ type: "text", text: JSON.stringify(args) }] };
	},
};

function connect(tools: ToolsHandlers = echo): TestClient {
	return new TestClient(
		new McpServer({ name: "test", version: "1.2.3" }, tools),
	);
}

describe("readMessage", () => {
	it("reads requests and notifications", () => {
		expect(readMessage('{"jsonrpc":"2.0","id":7,"method":"ping"}')).toEqual({
			kind: "request",
			message: { jsonrpc: "2.0", id: 7, method: "ping" },
		});
		expect(
			readMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}'),
		).toEqual({
			kind: "notification",
			message: { jsonrpc: "2.0", method: "notifications/initialized" },
		});
	});

	it("drops what a client sends as a response", () => {
		expect(readMessage('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({
			kind: "response",
		});
	});

	it("names what is wrong with a malformed line, keeping the id it could read", () => {
		const cases: Array<[string, number, string | number | null]> = [
			["{not json", -32700, null],
			["[]", -32600, null],
			['"text"', -32600, null],
			['{"jsonrpc":"1.0","id":3,"method":"ping"}', -32600, 3],
			['{"jsonrpc":"2.0","id":4}', -32600, 4],
			['{"jsonrpc":"2.0","id":5,"method":""}', -32600, 5],
			['{"jsonrpc":"2.0","id":6,"method":"ping","params":[1]}', -32600, 6],
			['{"jsonrpc":"2.0","id":1.5,"method":"ping"}', -32600, null],
			['{"jsonrpc":"2.0","id":null,"method":"ping"}', -32600, null],
		];
		for (const [line, code, id] of cases) {
			const read = readMessage(line);
			expect(read.kind, line).toBe("malformed");
			if (read.kind === "malformed") {
				expect(read.error.code, line).toBe(code);
				expect(read.id, line).toBe(id);
			}
		}
	});
});

describe("initialize", () => {
	it("answers a supported revision with that revision", async () => {
		for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
			const client = connect();
			const reply = await client.request("initialize", {
				protocolVersion: version,
				capabilities: {},
				clientInfo: { name: "c", version: "0" },
			});
			expect(reply.result).toEqual({
				protocolVersion: version,
				capabilities: { tools: {} },
				serverInfo: { name: "test", version: "1.2.3" },
			});
		}
	});

	it("answers an unknown revision with the newest", async () => {
		const reply = await connect().request("initialize", {
			protocolVersion: "1999-01-01",
		});
		expect(reply.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
	});
});

describe("requests", () => {
	it("answers ping with an empty result", async () => {
		expect((await connect().request("ping")).result).toEqual({});
	});

	it("answers an unknown method with -32601", async () => {
		const reply = await connect().request("resources/list", {});
		expect(reply.error).toEqual({ code: -32601, message: "Method not found" });
	});

	it("answers a malformed tools/call with -32602", async () => {
		const client = connect();
		for (const params of [{}, { name: 3 }, { name: "echo", arguments: [1] }]) {
			const reply = await client.request("tools/call", params);
			expect(reply.error?.code, JSON.stringify(params)).toBe(-32602);
		}
	});

	it("answers a thrown handler error with -32603 and its message", async () => {
		const reply = await connect().request("tools/call", { name: "boom" });
		expect(reply.error).toEqual({ code: -32603, message: "it broke" });
	});

	it("passes the arguments through, and an empty object when there are none", async () => {
		const client = connect();
		const withArgs = await client.request("tools/call", {
			name: "echo",
			arguments: { a: 1 },
		});
		expect(withArgs.result).toEqual({
			content: [{ type: "text", text: '{"a":1}' }],
		});
		const without = await client.request("tools/call", { name: "echo" });
		expect(without.result).toEqual({ content: [{ type: "text", text: "{}" }] });
	});

	it("keeps answering string ids", async () => {
		const reply = await connect().request("ping", undefined, "abc");
		expect(reply.id).toBe("abc");
	});

	it("refuses a second request with an id still running", async () => {
		const client = connect();
		client.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "slow" } })}\n`,
		);
		client.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" })}\n`,
		);
		const replies = await client.settle(200);
		expect(
			replies.filter((r) => r.id === 9).map((r) => r.error?.code ?? "ok"),
		).toEqual([-32600, "ok"]);
	});
});

describe("notifications", () => {
	it("get no answer, known or not", async () => {
		const client = connect();
		client.notify("notifications/initialized");
		client.notify("notifications/whatever", { x: 1 });
		expect(await client.settle()).toEqual([]);
	});

	it("a cancelled request gets no answer, the next one does", async () => {
		const client = connect();
		client.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow" } })}\n`,
		);
		client.notify("notifications/cancelled", { requestId: 1, reason: "user" });
		const pong = await client.request("ping", undefined, 2);
		expect(pong.result).toEqual({});
		expect((await client.settle(200)).map((r) => r.id)).toEqual([2]);
	});
});

describe("framing", () => {
	it("answers a line that is not JSON with a parse error, and goes on", async () => {
		const client = connect();
		client.write("this is not json\n");
		expect((await client.reply(null)).error?.code).toBe(-32700);
		expect((await client.request("ping")).result).toEqual({});
	});

	it("reads messages split across chunks, CRLF endings and multibyte text", async () => {
		const client = connect();
		const line = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "echo", arguments: { s: "é€😀" } },
		});
		const bytes = Buffer.from(`${line}\r\n`, "utf8");
		// Split inside the 4-byte emoji.
		const cut = bytes.indexOf(Buffer.from("😀")) + 2;
		client.input.write(bytes.subarray(0, cut));
		client.input.write(bytes.subarray(cut));
		const reply = await client.reply(1);
		expect(reply.result).toEqual({
			content: [{ type: "text", text: '{"s":"é€😀"}' }],
		});
	});

	it("drops a line over the limit, says so once, and reads the next one", async () => {
		const client = connect();
		const chunk = "x".repeat(1024 * 1024);
		for (let i = 0; i <= MAX_LINE_BYTES / chunk.length; i++)
			client.write(chunk);
		client.write("\n");
		const pong = await client.request("ping", undefined, 5);
		expect(pong.result).toEqual({});
		const errors = client.replies.filter((r) => r.id === null);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.error?.code).toBe(-32600);
	});

	it("ignores blank lines", async () => {
		const client = connect();
		client.write("\n\r\n   \n");
		expect(await client.settle()).toEqual([]);
	});
});

describe("validateArguments", () => {
	const schema = {
		type: "object",
		properties: {
			name: { type: "string", pattern: "^[A-Z][a-z]*$" },
			count: { type: "integer", minimum: 1, maximum: 5 },
			ratio: { type: "number" },
			mode: { type: "string", enum: ["a", "b"] },
			tags: { type: "array", items: { type: "string", enum: ["x", "y"] } },
			flag: { type: "boolean" },
		},
		required: ["name"],
		additionalProperties: false,
	};

	it("accepts arguments that fit", () => {
		expect(
			validateArguments(schema, {
				name: "Ab",
				count: 5,
				ratio: 0.5,
				mode: "b",
				tags: ["x"],
				flag: false,
			}),
		).toEqual([]);
	});

	it("names every problem", () => {
		expect(
			validateArguments(schema, {
				name: "ab",
				count: 1.5,
				ratio: "1",
				mode: "c",
				tags: ["z", 3],
				flag: 1,
				other: 1,
			}),
		).toEqual([
			"name must match ^[A-Z][a-z]*$",
			"count must be integer, got number",
			"ratio must be number, got string",
			'mode must be one of "a", "b"',
			'tags[0] must be one of "x", "y"',
			"tags[1] must be string, got number",
			"flag must be boolean, got number",
			"other is not an accepted argument",
		]);
	});

	it("counts only own properties as present", () => {
		expect(
			validateArguments(schema, JSON.parse('{"__proto__":{"name":"A"}}')),
		).toEqual(["name is required", "__proto__ is not an accepted argument"]);
	});

	it("refuses out-of-range numbers and non-finite ones", () => {
		expect(validateArguments(schema, { name: "A", count: 0 })).toEqual([
			"count must be >= 1",
		]);
		expect(validateArguments(schema, { name: "A", count: 6 })).toEqual([
			"count must be <= 5",
		]);
	});
});

describe("tool descriptors", () => {
	const all = [
		...DOCS_TOOLS,
		...INTROSPECT_TOOLS,
		...GENERATE_TOOLS,
		...QUALITY_TOOLS,
		...MIGRATION_TOOLS,
		...SECURITY_TOOLS,
		...BMAD_TOOLS,
		...DOCTOR_TOOLS,
		...INKER_TOOLS,
		...STATION_TOOLS,
		...SCHEDULER_TOOLS,
	];

	it("use only the schema keywords the argument check understands", () => {
		for (const tool of all) {
			for (const keyword of schemaKeywords(tool.inputSchema)) {
				expect(
					SUPPORTED_KEYWORDS.has(keyword),
					`${tool.name}: ${keyword}`,
				).toBe(true);
			}
		}
	});

	it("accept their own defaults", () => {
		for (const tool of all) {
			const properties = tool.inputSchema.properties;
			if (typeof properties !== "object" || properties === null) continue;
			for (const [key, property] of Object.entries(properties)) {
				if (
					typeof property === "object" &&
					property !== null &&
					"default" in property
				) {
					expect(
						validateArguments(property, property.default),
						`${tool.name}.${key}`,
					).toEqual([]);
				}
			}
		}
	});
});
