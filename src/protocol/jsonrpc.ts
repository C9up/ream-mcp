/**
 * JSON-RPC 2.0 as the Model Context Protocol uses it: the message shapes, the
 * error codes, and a reader that turns one parsed line into a message or says
 * why it is not one.
 *
 * Everything that arrives on stdin is untrusted. Nothing here assumes a shape
 * it has not checked, and nothing here throws on bad input: a malformed
 * message becomes a {@link Malformed} the server answers with an error.
 */

export type RequestId = string | number;

export type JsonObject = { [key: string]: unknown };

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: RequestId;
	method: string;
	params?: JsonObject;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: JsonObject;
}

export interface JsonRpcSuccess {
	jsonrpc: "2.0";
	id: RequestId;
	result: JsonObject;
}

export interface JsonRpcErrorBody {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcFailure {
	jsonrpc: "2.0";
	id: RequestId | null;
	error: JsonRpcErrorBody;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** The codes JSON-RPC 2.0 reserves, as MCP uses them. */
export const ErrorCode = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603,
} as const;

/**
 * A failure a handler reports as a JSON-RPC error rather than a result: an
 * unknown tool, a malformed `tools/call`. Anything else a handler throws is
 * answered as an internal error.
 */
export class McpError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "McpError";
		this.code = code;
		this.data = data;
	}
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A line that is not a message the server can act on, and the error to send. */
export interface Malformed {
	kind: "malformed";
	/** The request id when one could be read, so the client can match the error. */
	id: RequestId | null;
	error: JsonRpcErrorBody;
}

export type Incoming =
	| { kind: "request"; message: JsonRpcRequest }
	| { kind: "notification"; message: JsonRpcNotification }
	/** A response or error from the client: this server sends no requests, so it is dropped. */
	| { kind: "response" }
	| Malformed;

function isRequestId(value: unknown): value is RequestId {
	return (
		typeof value === "string" ||
		(typeof value === "number" && Number.isSafeInteger(value))
	);
}

function malformed(
	id: RequestId | null,
	code: number,
	message: string,
): Malformed {
	return { kind: "malformed", id, error: { code, message } };
}

/** Parse one line of the stdio stream. */
export function readMessage(line: string): Incoming {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return malformed(null, ErrorCode.ParseError, "Parse error");
	}
	if (Array.isArray(parsed)) {
		// MCP 2025-06-18 removed JSON-RPC batching; the SDK refuses a batch too.
		return malformed(
			null,
			ErrorCode.InvalidRequest,
			"Invalid Request: batches are not supported",
		);
	}
	if (!isJsonObject(parsed)) {
		return malformed(
			null,
			ErrorCode.InvalidRequest,
			"Invalid Request: not an object",
		);
	}
	const rawId = parsed.id;
	const id = isRequestId(rawId) ? rawId : null;
	if (parsed.jsonrpc !== "2.0") {
		return malformed(
			id,
			ErrorCode.InvalidRequest,
			'Invalid Request: jsonrpc must be "2.0"',
		);
	}
	if (!("method" in parsed)) {
		if ("result" in parsed || "error" in parsed) return { kind: "response" };
		return malformed(
			id,
			ErrorCode.InvalidRequest,
			"Invalid Request: no method",
		);
	}
	const method = parsed.method;
	if (typeof method !== "string" || method.length === 0) {
		return malformed(
			id,
			ErrorCode.InvalidRequest,
			"Invalid Request: method must be a non-empty string",
		);
	}
	const params = parsed.params;
	if (params !== undefined && !isJsonObject(params)) {
		return malformed(
			id,
			ErrorCode.InvalidRequest,
			"Invalid Request: params must be an object",
		);
	}
	if (!("id" in parsed)) {
		return {
			kind: "notification",
			message: { jsonrpc: "2.0", method, ...(params ? { params } : {}) },
		};
	}
	if (id === null) {
		return malformed(
			null,
			ErrorCode.InvalidRequest,
			"Invalid Request: id must be a string or an integer",
		);
	}
	return {
		kind: "request",
		message: { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) },
	};
}
