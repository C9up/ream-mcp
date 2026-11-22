/**
 * The Model Context Protocol server ream-mcp speaks: `initialize`, `ping`,
 * `tools/list`, `tools/call`, and the `initialized` and `cancelled`
 * notifications. That is all ream-mcp offers, so that is all this answers;
 * any other method is "Method not found".
 *
 * It replaces `@modelcontextprotocol/sdk` 1.32, whose low-level `Server`
 * ream-mcp used for exactly these methods. Its behaviour is kept where a
 * client can observe it — version negotiation, the error codes, the result
 * shapes — with two NAMED DEVIATIONS, both answers where the SDK said nothing:
 *
 * - A line that is not JSON, or not a JSON-RPC message, gets a JSON-RPC error
 *   (Parse error / Invalid Request, id null when none could be read). The SDK
 *   reported it to its own `onerror` and the client waited for an answer that
 *   never came.
 * - A line over the size limit gets one Invalid Request error instead of the
 *   SDK's silent close of the transport.
 *
 * A `tools/call` without a tool name, or with arguments that are not an
 * object, is Invalid params (-32602); the SDK's schema check let that surface
 * as an internal error.
 */

import type { Readable, Writable } from "node:stream";

import {
	ErrorCode,
	type Incoming,
	isJsonObject,
	type JsonObject,
	type JsonRpcRequest,
	McpError,
	type RequestId,
	readMessage,
} from "./jsonrpc.js";
import { MAX_LINE_BYTES, StdioLines } from "./stdio.js";

/**
 * The protocol revisions this server answers in, newest first: the list
 * `@modelcontextprotocol/sdk` 1.32.2 negotiates (`SUPPORTED_PROTOCOL_VERSIONS`
 * in its `types.js`). A client asking for one of them gets it back; any other
 * request gets the newest, and the client decides whether to go on.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
	"2025-11-25",
	"2025-06-18",
	"2025-03-26",
	"2024-11-05",
	"2024-10-07",
] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export interface ServerInfo {
	name: string;
	version: string;
}

export interface CallToolParams {
	name: string;
	arguments: JsonObject;
}

export interface ToolsHandlers {
	list(): JsonObject | Promise<JsonObject>;
	call(params: CallToolParams): JsonObject | Promise<JsonObject>;
}

function negotiate(requested: unknown): string {
	return (
		SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === requested) ??
		LATEST_PROTOCOL_VERSION
	);
}

/** `tools/call`'s params, or the reason they are not usable. */
function callParams(params: JsonObject | undefined): CallToolParams {
	const name = params?.name;
	if (typeof name !== "string" || name.length === 0) {
		throw new McpError(
			ErrorCode.InvalidParams,
			"Invalid params: tools/call needs a tool name",
		);
	}
	const args = params?.arguments;
	if (args !== undefined && !isJsonObject(args)) {
		throw new McpError(
			ErrorCode.InvalidParams,
			"Invalid params: tools/call arguments must be an object",
		);
	}
	return { name, arguments: args ?? {} };
}

export class McpServer {
	readonly #info: ServerInfo;
	readonly #tools: ToolsHandlers;
	#lines: StdioLines | null = null;
	/** Requests still running, so a `notifications/cancelled` can silence one. */
	readonly #inFlight = new Set<RequestId>();
	readonly #cancelled = new Set<RequestId>();
	#onClose: (() => void) | null = null;

	constructor(info: ServerInfo, tools: ToolsHandlers) {
		this.#info = info;
		this.#tools = tools;
	}

	/** Start reading messages from `input` and answering on `output`. */
	connect(input: Readable, output: Writable): void {
		if (this.#lines) throw new Error("McpServer is already connected");
		this.#lines = new StdioLines(input, output, {
			line: (text) => {
				void this.#receive(readMessage(text));
			},
			oversized: () => {
				void this.#lines?.send({
					jsonrpc: "2.0",
					id: null,
					error: {
						code: ErrorCode.InvalidRequest,
						message: `Invalid Request: message over ${MAX_LINE_BYTES} bytes`,
					},
				});
			},
			end: () => {
				this.#onClose?.();
			},
		});
	}

	/** Called once when the input ends or {@link close} runs. */
	set onclose(listener: (() => void) | null) {
		this.#onClose = listener;
	}

	async close(): Promise<void> {
		this.#lines?.close();
	}

	async #receive(incoming: Incoming): Promise<void> {
		switch (incoming.kind) {
			case "malformed":
				await this.#lines?.send({
					jsonrpc: "2.0",
					id: incoming.id,
					error: incoming.error,
				});
				return;
			case "response":
				return;
			case "notification":
				this.#notify(incoming.message.method, incoming.message.params);
				return;
			case "request":
				await this.#answer(incoming.message);
				return;
		}
	}

	#notify(method: string, params: JsonObject | undefined): void {
		if (method !== "notifications/cancelled") return;
		const id = params?.requestId;
		if (
			(typeof id === "string" || typeof id === "number") &&
			this.#inFlight.has(id)
		) {
			this.#cancelled.add(id);
		}
	}

	async #answer(request: JsonRpcRequest): Promise<void> {
		const { id } = request;
		if (this.#inFlight.has(id)) {
			await this.#lines?.send({
				jsonrpc: "2.0",
				id,
				error: {
					code: ErrorCode.InvalidRequest,
					message: "Invalid Request: id already in use",
				},
			});
			return;
		}
		this.#inFlight.add(id);
		let reply: object;
		try {
			const result = await this.#dispatch(request);
			reply = { jsonrpc: "2.0", id, result };
		} catch (err) {
			reply = {
				jsonrpc: "2.0",
				id,
				error:
					err instanceof McpError
						? {
								code: err.code,
								message: err.message,
								...(err.data === undefined ? {} : { data: err.data }),
							}
						: {
								code: ErrorCode.InternalError,
								message: err instanceof Error ? err.message : String(err),
							},
			};
		} finally {
			this.#inFlight.delete(id);
		}
		// A cancelled request gets no answer (MCP, cancellation: "SHOULD NOT
		// send a response for the cancelled request").
		if (this.#cancelled.delete(id)) return;
		await this.#lines?.send(reply);
	}

	async #dispatch(request: JsonRpcRequest): Promise<JsonObject> {
		switch (request.method) {
			case "initialize":
				return {
					protocolVersion: negotiate(request.params?.protocolVersion),
					capabilities: { tools: {} },
					serverInfo: { name: this.#info.name, version: this.#info.version },
				};
			case "ping":
				return {};
			case "tools/list":
				return await this.#tools.list();
			case "tools/call":
				return await this.#tools.call(callParams(request.params));
			default:
				throw new McpError(ErrorCode.MethodNotFound, "Method not found");
		}
	}
}
