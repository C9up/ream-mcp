/**
 * A minimal MCP client over in-memory streams, for driving an
 * {@link McpServer} in tests the way a real client drives it over stdio:
 * one JSON message per line.
 */

import { PassThrough } from "node:stream";

import type { RequestId } from "../src/protocol/jsonrpc.js";
import type { McpServer } from "../src/protocol/server.js";

export interface RpcReply {
	jsonrpc: "2.0";
	id: RequestId | null;
	result?: Record<string, unknown>;
	error?: { code: number; message: string; data?: unknown };
}

function isReply(value: unknown): value is RpcReply {
	return (
		typeof value === "object" &&
		value !== null &&
		"jsonrpc" in value &&
		value.jsonrpc === "2.0" &&
		"id" in value
	);
}

export class TestClient {
	readonly input = new PassThrough();
	readonly output = new PassThrough();
	readonly replies: RpcReply[] = [];
	#buffer = "";
	#waiters: Array<() => void> = [];
	#nextId = 1;

	constructor(server: McpServer) {
		this.output.setEncoding("utf8");
		this.output.on("data", (chunk: string) => {
			this.#buffer += chunk;
			for (
				let nl = this.#buffer.indexOf("\n");
				nl !== -1;
				nl = this.#buffer.indexOf("\n")
			) {
				const line = this.#buffer.slice(0, nl);
				this.#buffer = this.#buffer.slice(nl + 1);
				const parsed: unknown = JSON.parse(line);
				if (!isReply(parsed)) throw new Error(`not a reply: ${line}`);
				this.replies.push(parsed);
				for (const wake of this.#waiters.splice(0)) wake();
			}
		});
		server.connect(this.input, this.output);
	}

	/** Write raw text, as a client with a bug might. */
	write(text: string): void {
		this.input.write(text);
	}

	notify(method: string, params?: Record<string, unknown>): void {
		this.write(
			`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`,
		);
	}

	/** Send a request and wait for the reply with its id. */
	request(
		method: string,
		params?: Record<string, unknown>,
		id: RequestId = this.#nextId++,
	): Promise<RpcReply> {
		this.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`,
		);
		return this.reply(id);
	}

	/** The reply with `id`, once it arrives. */
	async reply(id: RequestId | null, ms = 10_000): Promise<RpcReply> {
		const deadline = Date.now() + ms;
		for (;;) {
			const found = this.replies.find((r) => r.id === id);
			if (found) return found;
			const left = deadline - Date.now();
			if (left <= 0)
				throw new Error(`no reply for id ${String(id)} within ${ms}ms`);
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, left);
				this.#waiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}

	/** Let pending messages be processed, then return everything received. */
	async settle(ms = 50): Promise<RpcReply[]> {
		await new Promise((resolve) => setTimeout(resolve, ms));
		return this.replies;
	}
}
