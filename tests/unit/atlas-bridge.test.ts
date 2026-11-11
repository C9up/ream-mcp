/**
 * `atlas-bridge` unit tests — Story 33.6.
 *
 * Pure-function coverage for URL resolution priority, dialect
 * detection, and migration-name splitting. The actual `buildAtlasBridge`
 * Atlas import is exercised by the `migration-*` integration tests.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	buildAtlasBridge,
	detectDialect,
	resolveDatabaseUrl,
	resolveMigrationsDir,
	resolveMigrationsTable,
	splitMigrationName,
} from "../../src/util/atlas-bridge.js";

const SAVED_REAM = process.env.REAM_DATABASE_URL;
const SAVED_DB = process.env.DATABASE_URL;
const SAVED_DBVAR = process.env.MY_DB_URL;
const SAVED_MIG = process.env.REAM_MIGRATIONS_DIR;
const SAVED_MIG_TABLE = process.env.REAM_MIGRATIONS_TABLE;

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "atlas-bridge-"));
	delete process.env.REAM_DATABASE_URL;
	delete process.env.DATABASE_URL;
	delete process.env.MY_DB_URL;
	delete process.env.REAM_MIGRATIONS_DIR;
	delete process.env.REAM_MIGRATIONS_TABLE;
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	if (SAVED_REAM === undefined) delete process.env.REAM_DATABASE_URL;
	else process.env.REAM_DATABASE_URL = SAVED_REAM;
	if (SAVED_DB === undefined) delete process.env.DATABASE_URL;
	else process.env.DATABASE_URL = SAVED_DB;
	if (SAVED_DBVAR === undefined) delete process.env.MY_DB_URL;
	else process.env.MY_DB_URL = SAVED_DBVAR;
	if (SAVED_MIG === undefined) delete process.env.REAM_MIGRATIONS_DIR;
	else process.env.REAM_MIGRATIONS_DIR = SAVED_MIG;
	if (SAVED_MIG_TABLE === undefined) delete process.env.REAM_MIGRATIONS_TABLE;
	else process.env.REAM_MIGRATIONS_TABLE = SAVED_MIG_TABLE;
});

describe("resolveDatabaseUrl", () => {
	it("prefers REAM_DATABASE_URL over DATABASE_URL", () => {
		process.env.REAM_DATABASE_URL = "sqlite::memory:";
		process.env.DATABASE_URL = "postgres://x/y";
		expect(resolveDatabaseUrl(tmpRoot)).toBe("sqlite::memory:");
	});

	it("falls back to DATABASE_URL when REAM_DATABASE_URL is unset", () => {
		process.env.DATABASE_URL = "mysql://x/y";
		expect(resolveDatabaseUrl(tmpRoot)).toBe("mysql://x/y");
	});

	it("returns null when neither env is set and no reamrc exists", () => {
		expect(resolveDatabaseUrl(tmpRoot)).toBeNull();
	});

	it("parses a literal url from reamrc.ts", () => {
		writeFileSync(
			join(tmpRoot, "reamrc.ts"),
			`export default {
				database: {
					default: "main",
					connections: {
						main: { url: "sqlite::memory:" }
					}
				}
			};`,
		);
		expect(resolveDatabaseUrl(tmpRoot)).toBe("sqlite::memory:");
	});

	it("resolves env('VAR') refs in reamrc.ts via process.env", () => {
		process.env.MY_DB_URL = "postgres://from-env/db";
		writeFileSync(
			join(tmpRoot, "reamrc.ts"),
			`declare function env(name: string, fallback?: string): string;
			export default {
				database: {
					default: "primary",
					connections: {
						primary: { url: env("MY_DB_URL", "sqlite::memory:") }
					}
				}
			};`,
		);
		expect(resolveDatabaseUrl(tmpRoot)).toBe("postgres://from-env/db");
	});

	it("falls back to env() default when the variable is unset", () => {
		writeFileSync(
			join(tmpRoot, "reamrc.ts"),
			`declare function env(name: string, fallback?: string): string;
			export default {
				database: {
					default: "primary",
					connections: {
						primary: { url: env("UNSET_VAR", "sqlite::default-fallback.db") }
					}
				}
			};`,
		);
		expect(resolveDatabaseUrl(tmpRoot)).toBe("sqlite::default-fallback.db");
	});
});

describe("resolveMigrationsDir", () => {
	it("uses REAM_MIGRATIONS_DIR when set", () => {
		process.env.REAM_MIGRATIONS_DIR = "/custom/path";
		expect(resolveMigrationsDir(tmpRoot)).toBe("/custom/path");
	});

	it("falls back to <root>/database/migrations", () => {
		expect(resolveMigrationsDir(tmpRoot)).toBe(
			join(tmpRoot, "database", "migrations"),
		);
	});
});

describe("resolveMigrationsTable", () => {
	it("uses REAM_MIGRATIONS_TABLE when set", () => {
		process.env.REAM_MIGRATIONS_TABLE = "schema_versions";
		expect(resolveMigrationsTable(tmpRoot)).toBe("schema_versions");
	});

	it("reads database.migrations.table from reamrc.ts when env is unset", () => {
		writeFileSync(
			join(tmpRoot, "reamrc.ts"),
			`export default {
				database: {
					default: "main",
					connections: { main: { url: "sqlite::memory:" } },
					migrations: { table: "tenant_a_migrations" }
				}
			};`,
		);
		expect(resolveMigrationsTable(tmpRoot)).toBe("tenant_a_migrations");
	});

	it("env override wins over reamrc.ts", () => {
		process.env.REAM_MIGRATIONS_TABLE = "from_env";
		writeFileSync(
			join(tmpRoot, "reamrc.ts"),
			`export default {
				database: {
					default: "main",
					connections: { main: { url: "sqlite::memory:" } },
					migrations: { table: "from_rc" }
				}
			};`,
		);
		expect(resolveMigrationsTable(tmpRoot)).toBe("from_env");
	});

	it("defaults to atlas's ream_migrations when env and config all miss", () => {
		expect(resolveMigrationsTable(tmpRoot)).toBe("ream_migrations");
	});

	it("defaults to ream_migrations when reamrc has no migrations table", () => {
		writeFileSync(
			join(tmpRoot, "reamrc.ts"),
			`export default {
				database: {
					default: "main",
					connections: { main: { url: "sqlite::memory:" } }
				}
			};`,
		);
		expect(resolveMigrationsTable(tmpRoot)).toBe("ream_migrations");
	});

	it("reads migrations.tableName from atlas's config/database.ts", () => {
		mkdirSync(join(tmpRoot, "config"));
		writeFileSync(
			join(tmpRoot, "config", "database.ts"),
			`import { defineConfig } from "@c9up/atlas";
			export default defineConfig({
				connection: "main",
				connections: { main: { url: "sqlite::memory:" } },
				migrations: { paths: ["database/migrations"], tableName: "schema_log" },
			});`,
		);
		expect(resolveMigrationsTable(tmpRoot)).toBe("schema_log");
	});

	it("prefers tableName over the older table key, as atlas does", () => {
		writeFileSync(
			join(tmpRoot, "reamrc.ts"),
			`export default {
				database: {
					default: "main",
					connections: { main: { url: "sqlite::memory:" } },
					migrations: { table: "old_key", tableName: "new_key" }
				}
			};`,
		);
		expect(resolveMigrationsTable(tmpRoot)).toBe("new_key");
	});

	it("atlas's config/database.ts wins over reamrc.ts", () => {
		mkdirSync(join(tmpRoot, "config"));
		writeFileSync(
			join(tmpRoot, "config", "database.ts"),
			`export default { migrations: { tableName: "from_atlas_config" } };`,
		);
		writeFileSync(
			join(tmpRoot, "reamrc.ts"),
			`export default { database: { migrations: { table: "from_rc" } } };`,
		);
		expect(resolveMigrationsTable(tmpRoot)).toBe("from_atlas_config");
	});
});

describe("detectDialect", () => {
	it("recognizes sqlite URL schemes", () => {
		expect(detectDialect("sqlite::memory:")).toBe("sqlite");
		expect(detectDialect("sqlite:foo.db")).toBe("sqlite");
		expect(detectDialect("sqlite3:foo.db")).toBe("sqlite");
	});

	it("recognizes postgres URL schemes", () => {
		expect(detectDialect("postgres://x/y")).toBe("postgres");
		expect(detectDialect("postgresql://x/y")).toBe("postgres");
	});

	it("recognizes mysql URL schemes", () => {
		expect(detectDialect("mysql://x/y")).toBe("mysql");
		expect(detectDialect("mysql2://x/y")).toBe("mysql");
	});

	it("returns null for unknown schemes", () => {
		expect(detectDialect("oracle://x/y")).toBeNull();
		expect(detectDialect("mongodb://x/y")).toBeNull();
		expect(detectDialect("file:foo.db")).toBeNull();
	});
});

describe("splitMigrationName", () => {
	it("splits {timestamp}_{name} convention", () => {
		expect(splitMigrationName("1700000000_create_users")).toEqual({
			id: "1700000000_create_users",
			name: "create_users",
		});
	});

	it("returns id===name when the filename has no underscore", () => {
		expect(splitMigrationName("seed_data")).toEqual({
			id: "seed_data",
			// `seed_data` HAS one underscore — split picks "data".
			name: "data",
		});
		expect(splitMigrationName("singleword")).toEqual({
			id: "singleword",
			name: "singleword",
		});
	});

	it("preserves multi-underscore names after the first split", () => {
		expect(splitMigrationName("20240101_add_index_to_users")).toEqual({
			id: "20240101_add_index_to_users",
			name: "add_index_to_users",
		});
	});
});

describe("buildAtlasBridge error messages", () => {
	it("does not echo a scheme-less URL (it may be all credentials)", async () => {
		process.env.REAM_DATABASE_URL = "S3cr3tP4ss@db.internal/appdb";
		const r = await buildAtlasBridge({ root: tmpRoot });
		const text = JSON.stringify(r);
		expect(text).not.toContain("S3cr3tP4ss");
		expect(text).not.toContain("db.internal");
	});

	it("names only a well-formed scheme", async () => {
		process.env.REAM_DATABASE_URL = "oracle://scott:tiger@db.internal/orcl";
		const r = await buildAtlasBridge({ root: tmpRoot });
		const text = JSON.stringify(r);
		expect(text).toContain("oracle");
		expect(text).not.toContain("tiger");
		expect(text).not.toContain("db.internal");
	});
});
