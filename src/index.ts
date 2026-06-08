#!/usr/bin/env node
/**
 * `@c9up/ream-mcp` bin entry. Wired in `package.json` so that
 * `npx @c9up/ream-mcp` (after `pnpm build`) launches the stdio MCP
 * server.
 *
 * Stdio MCP servers MUST NOT write to stdout — that corrupts the
 * JSON-RPC stream. Errors and observability go through stderr.
 *
 * `signal-bootstrap` MUST be imported before `server.js` so a
 * SIGTERM that arrives while heavy modules (ts-morph, MCP SDK) are
 * still loading is caught and translated into a clean exit. See
 * the module's header for the rationale.
 */

import "./signal-bootstrap.js";
import { bootstrap } from "./server.js";

bootstrap().catch((err: unknown) => {
	const detail =
		err instanceof Error ? (err.stack ?? err.message) : String(err);
	process.stderr.write(`[ream-mcp] fatal: ${detail}\n`);
	process.exit(1);
});
