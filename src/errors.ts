/**
 * ream-mcp errors, one class per code. Every refusal the server's own code
 * raises is a flare `Exception` with a code in the `E_REAM_MCP_` namespace, so
 * a caller can match on `error.code` or `error instanceof errors.E_REAM_MCP_…`.
 *
 * JSON-RPC protocol failures are not here: they reach the client as the
 * numeric JSON-RPC error codes the protocol defines.
 */
import { createError } from "@c9up/flare";

/** A tool or helper was called without a required argument, or with one out of range. */
export const E_REAM_MCP_INVALID_ARGUMENT = createError<[string]>(
	"%s",
	"E_REAM_MCP_INVALID_ARGUMENT",
);

/** No Ream project root was found walking up from the working directory. */
export const E_REAM_MCP_PROJECT_ROOT_NOT_FOUND = createError<[string]>(
	"ream-mcp: cannot detect a Ream project root walking up from '%s'. " +
		"Expected to find one of: reamrc.ts, ream.config.ts, or a package.json with '@c9up/ream' as a dependency. " +
		"Set REAM_PROJECT_ROOT=/path/to/project to override.",
	"E_REAM_MCP_PROJECT_ROOT_NOT_FOUND",
);

/** The native core did not report a version at startup. */
export const E_REAM_MCP_NATIVE_UNAVAILABLE = createError<[string]>(
	"ream-mcp: core.version() returned %s — Rust binary may be missing or incompatible. Try `pnpm --filter @c9up/ream-mcp build:napi`.",
	"E_REAM_MCP_NATIVE_UNAVAILABLE",
);

/** The native core answered something the server does not expect. */
export const E_REAM_MCP_NATIVE_MISMATCH = createError<[string]>(
	"%s",
	"E_REAM_MCP_NATIVE_MISMATCH",
);

/** The native corpus index could not be built, opened or read. */
export const E_REAM_MCP_INDEX_FAILED = createError<[string]>(
	"ream-mcp: the corpus index failed: %s",
	"E_REAM_MCP_INDEX_FAILED",
);

/** The native core could not read the JSON it was given, or write its answer as JSON. */
export const E_REAM_MCP_INVALID_JSON = createError<[string]>(
	"ream-mcp: the native core could not read or write JSON: %s",
	"E_REAM_MCP_INVALID_JSON",
);

/** A file name or path resolves outside its directory. */
export const E_REAM_MCP_PATH_ESCAPE = createError<[string]>(
	"%s",
	"E_REAM_MCP_PATH_ESCAPE",
);

/** A migration file does not export what the migration tools need. */
export const E_REAM_MCP_INVALID_MIGRATION = createError<[string, string]>(
	"%s: %s",
	"E_REAM_MCP_INVALID_MIGRATION",
);

/** Downloading an embeddings model file answered an HTTP error or no body. */
export const E_REAM_MCP_MODEL_DOWNLOAD_FAILED = createError<
	[string, number, string]
>("%s: HTTP %s from %s", "E_REAM_MCP_MODEL_DOWNLOAD_FAILED");

/** A downloaded model file does not match its pinned size or SHA-256. */
export const E_REAM_MCP_MODEL_INTEGRITY = createError<[string, string]>(
	"%s: %s",
	"E_REAM_MCP_MODEL_INTEGRITY",
);

/** `REAM_MCP_NO_SHELL=1` forbids spawning the `ream` binary. */
export const E_REAM_MCP_SHELL_DISALLOWED = createError(
	"ream-mcp: REAM_MCP_NO_SHELL=1 — refusing to spawn the ream binary in this environment.",
	"E_REAM_MCP_SHELL_DISALLOWED",
);

/** The `ream` binary is neither at `$REAM_BIN` nor in the project's `node_modules/.bin`. */
export const E_REAM_MCP_CLI_NOT_FOUND = createError(
	"ream-mcp: cannot locate the `ream` binary. " +
		"Looked at $REAM_BIN (must be inside project root or tmpdir) " +
		"and <root>/node_modules/.bin/ream. " +
		"Run `pnpm install` in the project, or set REAM_BIN to a valid path.",
	"E_REAM_MCP_CLI_NOT_FOUND",
);

/** The last line of the `ream` CLI's output is not a JSON object. */
export const E_REAM_MCP_CLI_OUTPUT_INVALID = createError<[string]>(
	"ream-mcp: %s",
	"E_REAM_MCP_CLI_OUTPUT_INVALID",
);

/** `McpServer.connect()` was called on a server that is already connected. */
export const E_REAM_MCP_ALREADY_CONNECTED = createError(
	"McpServer is already connected",
	"E_REAM_MCP_ALREADY_CONNECTED",
);

/** An internal invariant broke; report it as a bug. */
export const E_REAM_MCP_INTERNAL = createError<[string]>(
	"%s",
	"E_REAM_MCP_INTERNAL",
);
