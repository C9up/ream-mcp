/**
 * The native core, as the server's code calls it.
 *
 * The Rust binding raises its failures as plain errors whose message alone
 * says what went wrong (`json: …`, `opts parse: …`, `index: …`,
 * `store open: …`). Each call is wrapped here so the failure reaches the
 * caller as a ream-mcp error with a code, the native error kept as `cause`.
 */
import { core as native, type ReamMcpCore } from "../../index.js";
import { E_REAM_MCP_INDEX_FAILED, E_REAM_MCP_INVALID_JSON } from "../errors.js";

/** The prefixes the binding gives a JSON encoding or decoding failure. */
const JSON_PREFIXES = ["json: ", "opts parse: "];

/** The native failure as a ream-mcp error: a JSON failure, or one of the index and its store. */
function fromNative(cause: unknown): Error {
	const message = cause instanceof Error ? cause.message : String(cause);
	if (JSON_PREFIXES.some((prefix) => message.startsWith(prefix))) {
		return new E_REAM_MCP_INVALID_JSON([message], { cause });
	}
	return new E_REAM_MCP_INDEX_FAILED([message], { cause });
}

export const core: ReamMcpCore = {
	version: () => native.version(),

	embeddingModel() {
		try {
			return native.embeddingModel();
		} catch (cause) {
			throw fromNative(cause);
		}
	},

	async indexCorpus(root, full) {
		try {
			return await native.indexCorpus(root, full);
		} catch (cause) {
			throw fromNative(cause);
		}
	},

	search(root, query, optsJson) {
		try {
			return native.search(root, query, optsJson);
		} catch (cause) {
			throw fromNative(cause);
		}
	},

	getChunk(root, idOrTopic, byTopic) {
		try {
			return native.getChunk(root, idOrTopic, byTopic);
		} catch (cause) {
			throw fromNative(cause);
		}
	},

	trace(root, requirementId) {
		try {
			return native.trace(root, requirementId);
		} catch (cause) {
			throw fromNative(cause);
		}
	},

	auditDrift(root) {
		try {
			return native.auditDrift(root);
		} catch (cause) {
			throw fromNative(cause);
		}
	},
};
