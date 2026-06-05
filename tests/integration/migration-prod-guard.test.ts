/**
 * Production double-flag guard — Story 33.6.
 *
 * When the resolved env is `production`, both `confirm: true`
 * AND `allowProduction: true` are required. Either flag alone
 * returns the structured production refusal.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchMigration } from "../../src/tools/migration.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "migration-app");

const SAVED_NODE_ENV = process.env.NODE_ENV;
const SAVED_REAM_ENV = process.env.REAM_ENV;

let tmpDbDir: string;

beforeEach(() => {
	tmpDbDir = mkdtempSync(join(tmpdir(), "migration-prod-"));
	process.env.REAM_DATABASE_URL = `sqlite://${join(tmpDbDir, "test.db")}?mode=rwc`;
	delete process.env.REAM_ENV;
	delete process.env.NODE_ENV;
});

afterEach(() => {
	delete process.env.REAM_DATABASE_URL;
	if (SAVED_NODE_ENV === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = SAVED_NODE_ENV;
	if (SAVED_REAM_ENV === undefined) delete process.env.REAM_ENV;
	else process.env.REAM_ENV = SAVED_REAM_ENV;
	rmSync(tmpDbDir, { recursive: true, force: true });
});

interface ErrorShape {
	error: string;
	hint: string;
	confidence: "low";
	knownGaps: string[];
}

describe("migration > production guard", () => {
	it("refuses run with confirm:true but no allowProduction in production", async () => {
		process.env.NODE_ENV = "production";
		const result = (await dispatchMigration(FIXTURE, "migration.run", {
			dryRun: false,
			confirm: true,
		})) as ErrorShape;
		expect(result.error).toContain("production");
		expect(result.error).toContain("allowProduction");
		expect(result.confidence).toBe("low");
	});

	it("allows run with both flags in production", async () => {
		process.env.NODE_ENV = "production";
		const result = (await dispatchMigration(FIXTURE, "migration.run", {
			dryRun: false,
			confirm: true,
			allowProduction: true,
		})) as { ran: unknown[] } | ErrorShape;
		// Should NOT be the prod refusal — actual execution path.
		expect((result as ErrorShape).error).toBeUndefined();
		expect((result as { ran: unknown[] }).ran.length).toBe(2);
	});

	it("refuses rollback with confirm:true but no allowProduction in production", async () => {
		// First, apply migrations in dev so there's something to roll
		// back, THEN flip env to production for the rollback call.
		await dispatchMigration(FIXTURE, "migration.run", {
			dryRun: false,
			confirm: true,
		});
		process.env.NODE_ENV = "production";
		const result = (await dispatchMigration(FIXTURE, "migration.rollback", {
			dryRun: false,
			confirm: true,
		})) as ErrorShape;
		expect(result.error).toContain("production");
		expect(result.confidence).toBe("low");
	});

	it("dry-run is always safe regardless of env", async () => {
		process.env.NODE_ENV = "production";
		const result = (await dispatchMigration(FIXTURE, "migration.run", {
			dryRun: true,
		})) as { wouldRun: unknown[] };
		expect(result.wouldRun.length).toBe(2);
	});
});
