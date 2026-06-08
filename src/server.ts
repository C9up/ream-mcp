/**
 * MCP server bootstrap. Story 33.1 ships the skeleton — `initialize`
 * returns serverInfo + the `tools` capability, `tools/list` returns
 * the merged list. 33.2 added docs.*, 33.3 adds introspect.*.
 *
 * Stdio MCP servers MUST NOT write to stdout — that corrupts the
 * JSON-RPC stream. Every observability path here goes through
 * `process.stderr`. This is enforced by convention; future tools
 * inheriting from this server must not break it.
 *
 * **Boot ordering**: signal handlers are installed FIRST, before any
 * heavy module imports (ts-morph alone costs ~300ms). That way a
 * SIGTERM that arrives mid-boot is caught and translated into a
 * clean exit instead of process termination at exit code 143.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { core } from "../index.js";
import { uninstallEarlyHandlers } from "./signal-bootstrap.js";
import { errorContent, jsonContent } from "./tools/_helpers.js";
import { BMAD_TOOLS, isBmadTool } from "./tools/bmad.descriptors.js";
import { DOCS_TOOLS } from "./tools/docs.descriptors.js";
import { DOCTOR_TOOLS, isDoctorTool } from "./tools/doctor.descriptors.js";
import {
	GENERATE_TOOLS,
	isGenerateTool,
} from "./tools/generate.descriptors.js";
import { INKER_TOOLS, isInkerTool } from "./tools/inker.descriptors.js";
import {
	INTROSPECT_TOOLS,
	isIntrospectTool,
} from "./tools/introspect.descriptors.js";
import {
	isMigrationTool,
	MIGRATION_TOOLS,
} from "./tools/migration.descriptors.js";
import { isQualityTool, QUALITY_TOOLS } from "./tools/quality.descriptors.js";
import {
	isSchedulerTool,
	SCHEDULER_TOOLS,
} from "./tools/scheduler.descriptors.js";
import {
	isSecurityTool,
	SECURITY_TOOLS,
} from "./tools/security.descriptors.js";
import { isStationTool, STATION_TOOLS } from "./tools/station.descriptors.js";
import { detectProjectRoot } from "./util/project-root.js";
import { startStartupReindex } from "./util/startup-reindex.js";

const PKG_NAME = "@c9up/ream-mcp";
const PKG_VERSION = "0.1.0";
const SHUTDOWN_TIMEOUT_MS = 500;

export interface BootstrapOptions {
	/** Skip the FFI health check — useful for tests that don't want
	 *  to load the native binary. */
	skipNapiHealthCheck?: boolean;
}

export async function bootstrap(options: BootstrapOptions = {}): Promise<void> {
	const transportRef: { current: Closeable | null } = { current: null };
	const serverRef: { current: Closeable | null } = { current: null };
	installSignalHandlers(transportRef, serverRef);

	if (!options.skipNapiHealthCheck) {
		const rustVersion = core.version();
		if (typeof rustVersion !== "string" || rustVersion.length === 0) {
			throw new Error(
				`ream-mcp: core.version() returned ${JSON.stringify(rustVersion)} — Rust binary may be missing or incompatible. Try \`pnpm --filter @c9up/ream-mcp build:napi\`.`,
			);
		}
		process.stderr.write(`[ream-mcp] core ${rustVersion} loaded\n`);
	}

	const server = new Server(
		{ name: PKG_NAME, version: PKG_VERSION },
		{ capabilities: { tools: {} } },
	);

	// Audit 2026-05-22 F2: handlers MUST exist before the transport is
	// connected (any request that arrives before tools/list / tools/call
	// are registered would be rejected with "no handler") — but the
	// startup reindex now runs in the BACKGROUND. The previous order
	// awaited the reindex before `server.connect(transport)`, which
	// held the stdio pipe closed for the full duration of the corpus
	// index. An MCP client `initialize` request landed on a dead pipe
	// and timed out (a small project indexed in <1s passed the existing
	// integration test, but a real-world large project would not).
	//
	// Tools that depend on a fresh index (`docs.search`, etc.) await
	// the exported `indexReady` promise themselves; `tools/list`,
	// `initialize`, and the introspection / generate / quality /
	// migration / security / bmad / doctor families don't need the
	// docs corpus and respond instantly.
	registerAllTools(server);
	startStartupReindex();

	const transport = new StdioServerTransport();
	// Assign refs BEFORE connecting so a SIGTERM that arrives during
	// `await server.connect()` (which can take 10s-100s of ms on a
	// cold transport) sees the closeables and triggers a clean
	// shutdown instead of orphaning the file descriptor.
	transportRef.current = transport;
	serverRef.current = server;
	await server.connect(transport);
}

interface CallToolHandlerArgs {
	params: {
		name: string;
		arguments?: Record<string, unknown>;
	};
}

/**
 * Single combined tools/list + tools/call handler. The MCP SDK
 * keeps one handler per request type, so docs.* and introspect.*
 * must share a dispatcher rather than each calling
 * `setRequestHandler` and clobbering the other.
 *
 * Tool *descriptors* (the names + schemas served by tools/list)
 * are imported statically — they're tiny pure-data modules. Tool
 * *handlers* are dynamic-imported on first dispatch so the heavy
 * ts-morph dependency (~250ms CommonJS load) stays out of the
 * boot path. A SIGTERM during the first 500ms is caught by the
 * early handler and exits cleanly with code 0.
 */
export function registerAllTools(server: Server): void {
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
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
		],
	}));

	let handlersPromise: Promise<{
		dispatchDocs: typeof import("./tools/docs.js").dispatchDocs;
		dispatchIntrospect: typeof import("./tools/introspect.js").dispatchIntrospect;
		dispatchGenerate: typeof import("./tools/generate.js").dispatchGenerate;
		dispatchQuality: typeof import("./tools/quality.js").dispatchQuality;
		dispatchMigration: typeof import("./tools/migration.js").dispatchMigration;
		dispatchSecurity: typeof import("./tools/security.js").dispatchSecurity;
		dispatchBmad: typeof import("./tools/bmad.js").dispatchBmad;
		dispatchDoctor: typeof import("./tools/doctor.js").dispatchDoctor;
		dispatchInker: typeof import("./tools/inker.js").dispatchInker;
		dispatchStation: typeof import("./tools/station.js").dispatchStation;
		dispatchScheduler: typeof import("./tools/scheduler.js").dispatchScheduler;
	}> | null = null;
	const loadHandlers = () => {
		if (!handlersPromise) {
			handlersPromise = Promise.all([
				import("./tools/docs.js"),
				import("./tools/introspect.js"),
				import("./tools/generate.js"),
				import("./tools/quality.js"),
				import("./tools/migration.js"),
				import("./tools/security.js"),
				import("./tools/bmad.js"),
				import("./tools/doctor.js"),
				import("./tools/inker.js"),
				import("./tools/station.js"),
				import("./tools/scheduler.js"),
			])
				.then(([d, i, g, q, m, s, b, doc, ink, sta, sch]) => ({
					dispatchDocs: d.dispatchDocs,
					dispatchIntrospect: i.dispatchIntrospect,
					dispatchGenerate: g.dispatchGenerate,
					dispatchQuality: q.dispatchQuality,
					dispatchMigration: m.dispatchMigration,
					dispatchSecurity: s.dispatchSecurity,
					dispatchBmad: b.dispatchBmad,
					dispatchDoctor: doc.dispatchDoctor,
					dispatchInker: ink.dispatchInker,
					dispatchStation: sta.dispatchStation,
					dispatchScheduler: sch.dispatchScheduler,
				}))
				.catch((err: unknown) => {
					// Clear the cache so the NEXT tool call retries the
					// import. A transient FS hiccup or a fresh `pnpm
					// install` mid-session shouldn't permanently poison
					// the dispatcher.
					handlersPromise = null;
					throw err;
				});
		}
		return handlersPromise;
	};

	server.setRequestHandler(
		CallToolRequestSchema,
		async (req: CallToolHandlerArgs) => {
			const { name, arguments: args = {} } = req.params;
			let root: string;
			try {
				root = detectProjectRoot().path;
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				return jsonContent({ error: "project root not found", hint: detail });
			}
			try {
				const {
					dispatchDocs,
					dispatchIntrospect,
					dispatchGenerate,
					dispatchQuality,
					dispatchMigration,
					dispatchSecurity,
					dispatchBmad,
					dispatchDoctor,
					dispatchInker,
					dispatchStation,
					dispatchScheduler,
				} = await loadHandlers();
				if (isGenerateTool(name)) {
					return jsonContent(await dispatchGenerate(root, name, args));
				}
				if (isMigrationTool(name)) {
					return jsonContent(await dispatchMigration(root, name, args));
				}
				if (isSecurityTool(name)) {
					return jsonContent(await dispatchSecurity(root, name, args));
				}
				if (isBmadTool(name)) {
					return jsonContent(await dispatchBmad(root, name, args));
				}
				if (isDoctorTool(name)) {
					return jsonContent(await dispatchDoctor(root, name, args));
				}
				if (isQualityTool(name)) {
					return jsonContent(dispatchQuality(root, name, args));
				}
				if (isIntrospectTool(name)) {
					return jsonContent(dispatchIntrospect(root, name, args));
				}
				if (isInkerTool(name)) {
					return jsonContent(await dispatchInker(root, name, args));
				}
				if (isStationTool(name)) {
					return jsonContent(dispatchStation(root, name, args));
				}
				if (isSchedulerTool(name)) {
					return jsonContent(dispatchScheduler(root, name, args));
				}
				return jsonContent(await dispatchDocs(root, name, args));
			} catch (err) {
				const detail =
					err instanceof Error ? (err.stack ?? err.message) : String(err);
				process.stderr.write(`[ream-mcp] tool '${name}' failed: ${detail}\n`);
				return errorContent(`Tool '${name}' failed: ${detail}`);
			}
		},
	);
}

interface Closeable {
	close(): Promise<void>;
}

function installSignalHandlers(
	transportRef: { current: Closeable | null },
	serverRef: { current: Closeable | null },
): void {
	uninstallEarlyHandlers();
	let shuttingDown = false;
	const shutdown = (signal: string): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		process.stderr.write(`[ream-mcp] received ${signal}, closing\n`);

		const hardStop = setTimeout(() => {
			process.stderr.write(
				`[ream-mcp] shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit(1)\n`,
			);
			process.exit(1);
		}, SHUTDOWN_TIMEOUT_MS);
		hardStop.unref();

		// If the signal arrived before transport/server were assigned
		// (very fast SIGTERM during boot), nothing to close — just
		// exit cleanly. The Node default would have been exit 143.
		const closeables = [transportRef.current, serverRef.current].filter(
			(c): c is Closeable => c !== null,
		);
		if (closeables.length === 0) {
			clearTimeout(hardStop);
			process.exit(0);
			return;
		}

		void Promise.allSettled(closeables.map((c) => c.close())).then(
			(results) => {
				clearTimeout(hardStop);
				const failures = results.filter(
					(r): r is PromiseRejectedResult => r.status === "rejected",
				);
				for (const f of failures) {
					const reason = f.reason;
					const detail =
						reason instanceof Error
							? (reason.stack ?? reason.message)
							: String(reason);
					process.stderr.write(`[ream-mcp] close() rejected: ${detail}\n`);
				}
				process.exit(failures.length === 0 ? 0 : 1);
			},
		);
	};

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));

	process.on("unhandledRejection", (reason) => {
		const detail =
			reason instanceof Error
				? (reason.stack ?? reason.message)
				: String(reason);
		process.stderr.write(`[ream-mcp] unhandledRejection: ${detail}\n`);
		process.exit(1);
	});
	process.on("uncaughtException", (err) => {
		process.stderr.write(
			`[ream-mcp] uncaughtException: ${err.stack ?? err.message}\n`,
		);
		process.exit(1);
	});
}
