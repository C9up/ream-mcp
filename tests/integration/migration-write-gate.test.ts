/**
 * The migration write gate cannot be opened by the tool caller.
 *
 * Writes are enabled by launch-time env flags only, and a target that is not
 * provably local counts as production whatever NODE_ENV says.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchMigration } from "../../src/tools/migration.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(
	HERE,
	"..",
	"fixtures",
	"migration-app",
	"database",
	"migrations",
);

const VARS = [
	"REAM_ENV",
	"NODE_ENV",
	"REAM_DATABASE_URL",
	"DATABASE_URL",
	"REAM_MIGRATIONS_DIR",
	"REAM_MCP_ALLOW_MIGRATIONS",
	"REAM_MCP_ALLOW_PRODUCTION_MIGRATIONS",
] as const;
const saved = new Map<string, string | undefined>();

let base: string;
let project: string;
let outside: string;

beforeEach(() => {
	for (const v of VARS) {
		saved.set(v, process.env[v]);
		delete process.env[v];
	}
	base = mkdtempSync(join(tmpdir(), "migration-gate-"));
	project = join(base, "project");
	outside = join(base, "outside");
	mkdirSync(project);
	mkdirSync(outside);
	process.env.REAM_MIGRATIONS_DIR = MIGRATIONS;
});

afterEach(() => {
	for (const v of VARS) {
		const value = saved.get(v);
		if (value === undefined) delete process.env[v];
		else process.env[v] = value;
	}
	try {
		rmSync(base, { recursive: true, force: true });
	} catch {
		// win32 may still hold the sqlite file open
	}
});

function result(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		throw new Error(`expected an object, got ${JSON.stringify(value)}`);
	}
	return Object.fromEntries(Object.entries(value));
}

function sqliteUrl(path: string): string {
	return `sqlite://${path}?mode=rwc`;
}

describe("migration write gate", () => {
	it("refuses a confirmed run when the server was not launched with writes enabled", async () => {
		const db = join(project, "app.db");
		process.env.REAM_DATABASE_URL = sqliteUrl(db);
		const r = result(
			await dispatchMigration(project, "migration.run", {
				dryRun: false,
				confirm: true,
			}),
		);
		expect(r.error).toBe("migration writes are disabled for this server");
		expect(String(r.hint)).toContain("REAM_MCP_ALLOW_MIGRATIONS=1");
		// Refused before any connection was opened: the file was never created.
		expect(existsSync(db)).toBe(false);
	});

	it("still previews without any launch flag, in production", async () => {
		process.env.NODE_ENV = "production";
		process.env.REAM_DATABASE_URL = sqliteUrl(join(outside, "prod.db"));
		const r = result(await dispatchMigration(project, "migration.run", {}));
		expect(r.error).toBeUndefined();
		expect(Array.isArray(r.wouldRun) ? r.wouldRun.length : -1).toBe(2);
	});

	it("treats a remote database as production even with NODE_ENV unset", async () => {
		process.env.REAM_MCP_ALLOW_MIGRATIONS = "1";
		process.env.REAM_DATABASE_URL =
			"postgres://app:S3cr3tP4ss@db.invalid:5432/appdb";
		const r = result(
			await dispatchMigration(project, "migration.rollback", {
				dryRun: false,
				confirm: true,
			}),
		);
		expect(r.error).toBe(
			"production migration writes are disabled for this server",
		);
		expect(String(r.hint)).toContain("REAM_MCP_ALLOW_PRODUCTION_MIGRATIONS=1");
		const text = JSON.stringify(r);
		expect(text).not.toContain("S3cr3tP4ss");
		expect(text).not.toContain("db.invalid");
	});

	it("rejects the old caller-side env / allowProduction arguments", async () => {
		process.env.REAM_DATABASE_URL = sqliteUrl(join(outside, "prod.db"));
		for (const args of [
			{ dryRun: false, confirm: true, allowProduction: true },
			{ dryRun: false, confirm: true, env: "development" },
			{
				dryRun: false,
				confirm: true,
				env: "production",
				allowProduction: true,
			},
		]) {
			const r = result(
				await dispatchMigration(project, "migration.rollback", args),
			);
			expect(String(r.error)).toMatch(/is not a tool argument/);
			expect(String(r.hint)).toContain("launching ream-mcp");
		}
		expect(existsSync(join(outside, "prod.db"))).toBe(false);
	});

	it("treats a sqlite file outside the project as production", async () => {
		process.env.REAM_MCP_ALLOW_MIGRATIONS = "1";
		const db = join(outside, "prod.db");
		process.env.REAM_DATABASE_URL = sqliteUrl(db);
		const refused = result(
			await dispatchMigration(project, "migration.run", {
				dryRun: false,
				confirm: true,
			}),
		);
		expect(refused.error).toBe(
			"production migration writes are disabled for this server",
		);
		expect(String(refused.hint)).toContain("sqlite file outside the project");
		expect(existsSync(db)).toBe(false);

		process.env.REAM_MCP_ALLOW_PRODUCTION_MIGRATIONS = "1";
		const ran = result(
			await dispatchMigration(project, "migration.run", {
				dryRun: false,
				confirm: true,
			}),
		);
		expect(ran.error).toBeUndefined();
		expect(Array.isArray(ran.ran) ? ran.ran.length : -1).toBe(2);
	});

	it("does not let a symlinked directory inside the project pass as local", async () => {
		process.env.REAM_MCP_ALLOW_MIGRATIONS = "1";
		symlinkSync(outside, join(project, "data"), "dir");
		process.env.REAM_DATABASE_URL = sqliteUrl(join(project, "data", "app.db"));
		const r = result(
			await dispatchMigration(project, "migration.run", {
				dryRun: false,
				confirm: true,
			}),
		);
		expect(r.error).toBe(
			"production migration writes are disabled for this server",
		);
		expect(existsSync(join(outside, "app.db"))).toBe(false);
	});

	it("runs against a sqlite file inside the project once writes are enabled", async () => {
		process.env.REAM_MCP_ALLOW_MIGRATIONS = "1";
		process.env.REAM_DATABASE_URL = sqliteUrl(join(project, "app.db"));
		const r = result(
			await dispatchMigration(project, "migration.run", {
				dryRun: false,
				confirm: true,
			}),
		);
		expect(r.error).toBeUndefined();
		expect(Array.isArray(r.ran) ? r.ran.length : -1).toBe(2);
	});

	it("refuses in NODE_ENV=production without the production flag, and forces atlas's own guard with it", async () => {
		process.env.REAM_MCP_ALLOW_MIGRATIONS = "1";
		process.env.REAM_DATABASE_URL = sqliteUrl(join(project, "app.db"));
		await dispatchMigration(project, "migration.run", {
			dryRun: false,
			confirm: true,
		});

		process.env.NODE_ENV = "production";
		const refused = result(
			await dispatchMigration(project, "migration.rollback", {
				dryRun: false,
				confirm: true,
			}),
		);
		expect(refused.error).toBe(
			"production migration writes are disabled for this server",
		);
		expect(String(refused.hint)).toContain("NODE_ENV is production");

		// The user allowed production at launch: the rollback goes through,
		// instead of being allowed here and then refused by atlas.
		process.env.REAM_MCP_ALLOW_PRODUCTION_MIGRATIONS = "1";
		const done = result(
			await dispatchMigration(project, "migration.rollback", {
				dryRun: false,
				confirm: true,
			}),
		);
		expect(done.error).toBeUndefined();
		expect(Array.isArray(done.rolledBack) ? done.rolledBack.length : -1).toBe(
			2,
		);
	});
});
