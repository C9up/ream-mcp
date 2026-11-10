/**
 * Write gate for the `migration.*` MCP tools.
 *
 * Every tool argument is written by the model this gate restrains, so no
 * argument can open it. What a caller supplies is only an accident guard
 * (`confirm: true` on a `dryRun: false` call); what actually allows a write is
 * decided by the user when they launch the server:
 *
 *   - `REAM_MCP_ALLOW_MIGRATIONS=1` — migration.run / migration.rollback may
 *     write to a local database (a sqlite file inside the project, or a
 *     loopback / unix-socket server).
 *   - `REAM_MCP_ALLOW_PRODUCTION_MIGRATIONS=1` — additionally required when the
 *     target is production: `REAM_ENV` / `NODE_ENV` say so, OR the database URL
 *     points anywhere that is not provably local. An unset `NODE_ENV` is the
 *     normal state of a server launched by an editor, so the environment alone
 *     can never prove a target safe.
 *
 * Previews (`dryRun: true`) need neither flag, but they are not side-effect
 * free: they import each migration module and run its `up()` / `down()` in this
 * process to collect the SQL — see the `migration.*` descriptors.
 */

import { isAbsolute, resolve } from "node:path";

import { isInside, realpathOfNearest } from "./containment.js";

export const ALLOW_MIGRATIONS_ENV = "REAM_MCP_ALLOW_MIGRATIONS";
export const ALLOW_PRODUCTION_MIGRATIONS_ENV =
	"REAM_MCP_ALLOW_PRODUCTION_MIGRATIONS";

export interface ConsentArgs {
	dryRun: boolean;
	confirm: boolean;
}

export interface ConsentRefusal {
	error: string;
	hint: string;
}

/** Where a database URL points, as far as the gate is concerned. */
export interface TargetClass {
	local: boolean;
	/** Credential-free description, safe to hand back to the caller. */
	description: string;
}

export type WriteAuthorization =
	| { ok: true; production: boolean }
	| ({ ok: false } & ConsentRefusal);

/** The process environment, from `REAM_ENV` then `NODE_ENV`, lower-cased. */
export function detectEnv(): string {
	const reamEnv = process.env.REAM_ENV;
	if (typeof reamEnv === "string" && reamEnv.length > 0)
		return reamEnv.toLowerCase();
	const nodeEnv = process.env.NODE_ENV;
	if (typeof nodeEnv === "string" && nodeEnv.length > 0)
		return nodeEnv.toLowerCase();
	return "development";
}

function launchFlag(name: string): boolean {
	const value = process.env[name];
	if (typeof value !== "string") return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
}

/** The accident guard: a write call must say `confirm: true`. */
export function checkConsent(args: ConsentArgs): ConsentRefusal | null {
	if (args.dryRun) return null;
	if (args.confirm !== true) {
		return {
			error: "confirm: true required",
			hint: "set confirm: true to actually run; pass dryRun: true to preview the SQL",
		};
	}
	return null;
}

/**
 * Decide whether this server may write to `target`. Reads only the launch-time
 * flags and the process environment — never anything the caller sent.
 */
export function authorizeWrite(target: TargetClass): WriteAuthorization {
	if (!launchFlag(ALLOW_MIGRATIONS_ENV)) {
		return {
			ok: false,
			error: "migration writes are disabled for this server",
			hint: `Only previews (dryRun: true) are available. The user enables writes by launching ream-mcp with ${ALLOW_MIGRATIONS_ENV}=1; no tool argument can enable them.`,
		};
	}
	const envIsProduction = detectEnv() === "production";
	const production = envIsProduction || !target.local;
	if (production && !launchFlag(ALLOW_PRODUCTION_MIGRATIONS_ENV)) {
		const why = envIsProduction
			? "REAM_ENV / NODE_ENV is production"
			: `the database is ${target.description}, which is treated as production`;
		return {
			ok: false,
			error: "production migration writes are disabled for this server",
			hint: `${why}. The user enables production writes by launching ream-mcp with ${ALLOW_PRODUCTION_MIGRATIONS_ENV}=1 in addition to ${ALLOW_MIGRATIONS_ENV}=1; no tool argument can enable them.`,
		};
	}
	return { ok: true, production };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

function isLoopbackHost(host: string): boolean {
	const h = host.toLowerCase();
	return LOOPBACK_HOSTS.has(h) || LOOPBACK_V4.test(h);
}

const NOT_LOCAL: TargetClass = {
	local: false,
	description: "a database that is not provably local",
};

/**
 * Classify a database URL as local or not. Anything this function cannot
 * prove local — an unknown scheme, an unparsable URL, a remote host, a sqlite
 * file outside the project — is reported as not local.
 *
 * Relative sqlite paths resolve against `cwd`, as the driver resolves them.
 */
export function classifyTarget(
	url: string,
	projectRoot: string,
	cwd: string = process.cwd(),
): TargetClass {
	const lower = url.toLowerCase();
	if (lower.startsWith("sqlite:") || lower.startsWith("sqlite3:")) {
		return classifySqlite(url, projectRoot, cwd);
	}
	if (
		lower.startsWith("postgres:") ||
		lower.startsWith("postgresql:") ||
		lower.startsWith("mysql:") ||
		lower.startsWith("mysql2:")
	) {
		return classifyServer(url);
	}
	return NOT_LOCAL;
}

function classifyServer(url: string): TargetClass {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return NOT_LOCAL;
	}
	// libpq's `?host=` and mysql's `?socket=` override the authority part.
	const hostParam = parsed.searchParams.get("host");
	const socketParam = parsed.searchParams.get("socket");
	if (hostParam !== null && hostParam.length > 0) {
		if (hostParam.startsWith("/") || isLoopbackHost(hostParam)) {
			return { local: true, description: "a local database server" };
		}
		return {
			local: false,
			description: "a database host that is not loopback",
		};
	}
	if (socketParam?.startsWith("/") === true) {
		return { local: true, description: "a local database server" };
	}
	// No authority host at all means the driver's default unix socket.
	if (parsed.hostname.length === 0 || isLoopbackHost(parsed.hostname)) {
		return { local: true, description: "a local database server" };
	}
	return { local: false, description: "a database host that is not loopback" };
}

function classifySqlite(
	url: string,
	projectRoot: string,
	cwd: string,
): TargetClass {
	let rest = url.replace(/^sqlite3?:(?:\/\/)?/i, "");
	const queryAt = rest.indexOf("?");
	const query = queryAt === -1 ? "" : rest.slice(queryAt + 1);
	if (queryAt !== -1) rest = rest.slice(0, queryAt);
	const inMemory =
		rest === ":memory:" ||
		rest.length === 0 ||
		new URLSearchParams(query).get("mode") === "memory";
	if (inMemory)
		return { local: true, description: "an in-memory sqlite database" };
	if (rest.startsWith("file:")) rest = rest.slice("file:".length);
	let decoded: string;
	try {
		decoded = decodeURIComponent(rest);
	} catch {
		return NOT_LOCAL;
	}
	const realRoot = realpathOfNearest(resolve(projectRoot));
	// Whether the driver percent-decodes depends on the URL form, so the file
	// counts as inside only when both readings of the path are.
	const inside = (p: string): boolean => {
		const real = realpathOfNearest(isAbsolute(p) ? p : resolve(cwd, p));
		return real !== null && realRoot !== null && isInside(real, realRoot);
	};
	if (inside(rest) && inside(decoded)) {
		return { local: true, description: "a sqlite file inside the project" };
	}
	return { local: false, description: "a sqlite file outside the project" };
}
