/**
 * Atlas runner bridge — Story 33.6.
 *
 * Resolves the consumer project's database URL + migrations
 * directory, then dynamic-imports `@c9up/atlas` (peer dependency)
 * to instantiate `MigrationRunner` against a fresh
 * `AsyncDatabaseConnection`. Returns a structured `BridgeError`
 * for every failure mode — the dispatcher maps these to the
 * `shapeError` MCP envelope.
 *
 * Lifecycle: every dispatch builds a fresh bridge and the caller
 * MUST `await connection.close()` in a `finally` block to avoid
 * leaking sqlx connections. No caching, no pool reuse across
 * calls.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
	Node,
	type ObjectLiteralExpression,
	Project,
	SyntaxKind,
} from "ts-morph";

import { evaluateLiteral, extractEnvRef } from "./ts-static-parser.js";

export type Dialect = "sqlite" | "postgres" | "mysql";

export interface BridgeOptions {
	root: string;
}

export interface BridgeResult {
	// `runner` and `connection` are typed as `unknown` here so this
	// file imports zero `@c9up/atlas` symbols at module-evaluation
	// time. The dispatcher narrows them via the dynamic-import
	// types in `migration.ts`.
	runner: unknown;
	connection: { close(): Promise<void> };
	migrationsDir: string;
	migrationsDirExists: boolean;
	dialect: Dialect;
	supportsTransactions: boolean;
	/** Resolved migrations tracking-table name (env / reamrc / default), the
	 * same value handed to MigrationRunner — read queries MUST use this, not a
	 * hardcoded literal, or an overridden table is silently ignored. */
	migrationsTable: string;
}

/**
 * Structured failure envelope returned by `buildAtlasBridge` when
 * any of the five preflight categories fail:
 *   1. no database URL configured
 *   2. unsupported URL scheme (not sqlite/postgres/mysql)
 *   3. `@c9up/atlas` peer dependency not installed
 *   4. failed to open database connection (sqlx layer)
 *   5. ts-morph parse failure on `reamrc.ts` (returns category 1)
 *
 * The dispatcher in `migration.ts` maps these directly to the
 * `shapeError` MCP envelope.
 */
export interface BridgeError {
	error: string;
	hint: string;
}

export function isBridgeError(
	value: BridgeResult | BridgeError,
): value is BridgeError {
	return (
		typeof (value as BridgeError).error === "string" &&
		typeof (value as BridgeError).hint === "string"
	);
}

/**
 * Resolve the database URL via the documented priority order:
 *   1. `process.env.REAM_DATABASE_URL`
 *   2. `process.env.DATABASE_URL`
 *   3. `<root>/reamrc.ts` → `database.connections[database.default].url`
 *
 * Returns `null` when none resolves.
 */
export function resolveDatabaseUrl(root: string): string | null {
	const reamUrl = process.env.REAM_DATABASE_URL;
	if (typeof reamUrl === "string" && reamUrl.length > 0) return reamUrl;
	const stdUrl = process.env.DATABASE_URL;
	if (typeof stdUrl === "string" && stdUrl.length > 0) return stdUrl;
	return resolveFromReamrc(root);
}

function resolveFromReamrc(root: string): string | null {
	const rcPath = join(root, "reamrc.ts");
	if (!existsSync(rcPath)) return null;
	try {
		const objLit = loadReamrcConfigObject(rcPath);
		if (!objLit) return null;

		const dbObj = getObjectProperty(objLit, "database");
		if (!dbObj) return null;

		const defaultName = getStringProperty(dbObj, "default");
		if (!defaultName) return null;

		const connectionsObj = getObjectProperty(dbObj, "connections");
		if (!connectionsObj) return null;

		const namedConnObj = getObjectProperty(connectionsObj, defaultName);
		if (!namedConnObj) return null;

		const urlProp = namedConnObj.getProperty("url");
		if (!urlProp || !Node.isPropertyAssignment(urlProp)) return null;
		const urlInit = urlProp.getInitializer();
		if (!urlInit) return null;

		return resolveUrlValue(urlInit);
	} catch {
		return null;
	}
}

/** Parse `reamrc.ts` and unwrap its default export to the config object literal. */
function loadReamrcConfigObject(
	rcPath: string,
): ObjectLiteralExpression | null {
	const project = new Project({
		skipFileDependencyResolution: true,
		useInMemoryFileSystem: false,
	});
	project.addSourceFileAtPath(rcPath);
	const sf = project.getSourceFile(rcPath);
	if (!sf) return null;
	const [firstExport] = sf.getExportedDeclarations().get("default") ?? [];
	if (firstExport === undefined) return null;
	// `export default defineConfig({...})` or `export default { database: {...} }`.
	return unwrapToObjectLiteral(firstExport);
}

/** Get a property whose initializer is an object literal, or null. */
function getObjectProperty(
	obj: ObjectLiteralExpression,
	name: string,
): ObjectLiteralExpression | null {
	const prop = obj.getProperty(name);
	if (!prop || !Node.isPropertyAssignment(prop)) return null;
	const init = prop.getInitializer();
	return init && Node.isObjectLiteralExpression(init) ? init : null;
}

/** Get a property's value evaluated as a string literal, or null. */
function getStringProperty(
	obj: ObjectLiteralExpression,
	name: string,
): string | null {
	const prop = obj.getProperty(name);
	if (!prop || !Node.isPropertyAssignment(prop)) return null;
	return evaluateString(prop.getInitializerOrThrow());
}

/** Resolve a connection `url` initializer: env-ref first, then string literal. */
function resolveUrlValue(urlInit: Node): string | null {
	const envRef = extractEnvRef(urlInit);
	if (envRef) {
		const fromEnv = process.env[envRef.env];
		if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
		if (typeof envRef.default === "string") return envRef.default;
		return null;
	}
	const literal = evaluateLiteral(urlInit);
	return typeof literal === "string" ? literal : null;
}

function unwrapToObjectLiteral(
	decl: Node,
): import("ts-morph").ObjectLiteralExpression | null {
	if (Node.isObjectLiteralExpression(decl)) return decl;
	if (Node.isCallExpression(decl)) {
		const arg = decl.getArguments()[0];
		if (arg && Node.isObjectLiteralExpression(arg)) return arg;
	}
	if (Node.isVariableDeclaration(decl)) {
		const init = decl.getInitializer();
		if (init) return unwrapToObjectLiteral(init);
	}
	if (Node.isExportAssignment(decl)) {
		return unwrapToObjectLiteral(decl.getExpression());
	}
	// `export default { ... } satisfies Config` and `... as const`
	// wrap the literal in a SatisfiesExpression / AsExpression. Peel
	// those before falling back to descendant search.
	if (Node.isSatisfiesExpression(decl) || Node.isAsExpression(decl)) {
		return unwrapToObjectLiteral(decl.getExpression());
	}
	// Walk the first-level descendant to find an object literal — covers
	// the remaining wrapper forms.
	const inner = decl.getFirstDescendantByKind(
		SyntaxKind.ObjectLiteralExpression,
	);
	return inner ?? null;
}

function evaluateString(node: Node): string | null {
	const v = evaluateLiteral(node);
	return typeof v === "string" ? v : null;
}

export function resolveMigrationsDir(root: string): string {
	const override = process.env.REAM_MIGRATIONS_DIR;
	if (typeof override === "string" && override.length > 0) return override;
	return join(root, "database", "migrations");
}

const DEFAULT_MIGRATIONS_TABLE = "_migrations";

/**
 * Resolve the migrations tracking-table name. Precedence order:
 *   1. `process.env.REAM_MIGRATIONS_TABLE`
 *   2. `<root>/reamrc.ts` → `database.migrations.table`
 *   3. `"_migrations"` (default)
 *
 * No identifier validation here — `MigrationRunner` validates synchronously
 * at construction and throws `AtlasError("E_MIGRATION_INVALID_TABLE_NAME")`.
 */
export function resolveMigrationsTable(root: string): string {
	const override = process.env.REAM_MIGRATIONS_TABLE;
	if (typeof override === "string" && override.length > 0) return override;
	const fromRc = resolveMigrationsTableFromReamrc(root);
	return fromRc ?? DEFAULT_MIGRATIONS_TABLE;
}

function resolveMigrationsTableFromReamrc(root: string): string | null {
	const rcPath = join(root, "reamrc.ts");
	if (!existsSync(rcPath)) return null;
	try {
		const project = new Project({
			skipFileDependencyResolution: true,
			useInMemoryFileSystem: false,
		});
		project.addSourceFileAtPath(rcPath);
		const sf = project.getSourceFile(rcPath);
		if (!sf) return null;
		const [firstExport] = sf.getExportedDeclarations().get("default") ?? [];
		if (firstExport === undefined) return null;
		const objLit = unwrapToObjectLiteral(firstExport);
		if (!objLit) return null;

		const dbProp = objLit.getProperty("database");
		if (!dbProp || !Node.isPropertyAssignment(dbProp)) return null;
		const dbObj = dbProp.getInitializer();
		if (!dbObj || !Node.isObjectLiteralExpression(dbObj)) return null;

		const migrationsProp = dbObj.getProperty("migrations");
		if (!migrationsProp || !Node.isPropertyAssignment(migrationsProp))
			return null;
		const migrationsObj = migrationsProp.getInitializer();
		if (!migrationsObj || !Node.isObjectLiteralExpression(migrationsObj))
			return null;

		const tableProp = migrationsObj.getProperty("table");
		if (!tableProp || !Node.isPropertyAssignment(tableProp)) return null;
		const tableInit = tableProp.getInitializer();
		if (!tableInit) return null;
		return evaluateString(tableInit);
	} catch {
		return null;
	}
}

export function detectDialect(url: string): Dialect | null {
	const lower = url.toLowerCase();
	if (lower.startsWith("sqlite:") || lower.startsWith("sqlite3:"))
		return "sqlite";
	if (lower.startsWith("postgres:") || lower.startsWith("postgresql:"))
		return "postgres";
	if (lower.startsWith("mysql:") || lower.startsWith("mysql2:")) return "mysql";
	return null;
}

export async function buildAtlasBridge(
	opts: BridgeOptions,
): Promise<BridgeResult | BridgeError> {
	const url = resolveDatabaseUrl(opts.root);
	if (!url) {
		return {
			error: "no database URL configured",
			hint: "set REAM_DATABASE_URL, DATABASE_URL, or `database.connections.<default>.url` in reamrc.ts",
		};
	}
	const dialect = detectDialect(url);
	if (!dialect) {
		return {
			error: `unsupported database URL scheme: ${url.split(":")[0]}`,
			hint: "expected sqlite:, postgres:, or mysql: URL scheme",
		};
	}
	const migrationsDir = resolveMigrationsDir(opts.root);
	const migrationsDirExists = existsSync(migrationsDir);
	const tableName = resolveMigrationsTable(opts.root);
	// Defense-in-depth: tableName flows from env/reamrc into raw read SQL, so
	// reject anything that isn't a plain SQL identifier before it's exposed on
	// BridgeResult (MigrationRunner also validates, but fail clean here first).
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
		return {
			error: "invalid migrations table name",
			hint: `REAM_MIGRATIONS_TABLE / database.migrations.table must be a plain SQL identifier ([A-Za-z_][A-Za-z0-9_]*), got '${tableName}'`,
		};
	}

	let atlas: typeof import("@c9up/atlas");
	try {
		atlas = await import("@c9up/atlas");
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			error: "@c9up/atlas peer dependency not installed",
			hint: `install it in the consumer project (e.g. \`pnpm add @c9up/atlas\`) to use migration.* tools (${detail})`,
		};
	}

	// The type atlas actually returns, rather than a hand-written
	// `DatabaseAdapter & { close() }` that then needed a double cast to fit.
	let connection: import("@c9up/atlas").AsyncDatabaseConnection;
	try {
		connection = await atlas.createNapiConnection(url);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			error: "failed to open database connection",
			hint: detail,
		};
	}

	const supportsTransactions =
		typeof connection.runInTransaction === "function";
	const runner = new atlas.MigrationRunner(connection, {
		migrationsDir,
		dialect,
		tableName,
	});

	return {
		runner,
		connection,
		migrationsDir,
		migrationsDirExists,
		dialect,
		supportsTransactions,
		migrationsTable: tableName,
	};
}

const FILENAME_SPLIT = /^([^_]+)_(.+)$/;

/**
 * Convention: a migration filename is `{timestamp}_{name}` (e.g.
 * `1700000000_create_users`). The MCP wire shape exposes both
 * pieces as `id` (the full filename) and `name` (the part after
 * the first underscore). Filenames without an underscore yield
 * `id === name`.
 */
export function splitMigrationName(filename: string): {
	id: string;
	name: string;
} {
	const match = filename.match(FILENAME_SPLIT);
	if (!match) return { id: filename, name: filename };
	return { id: filename, name: match[2] ?? filename };
}
