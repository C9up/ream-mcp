/**
 * `migration.rollback` integration tests — Story 33.6.
 *
 * Covers the dry-run reverse-SQL preview, the strict-consent
 * refusal, the actual rollback, and the silent-cap behavior
 * when `step` exceeds applied batches.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchMigration } from "../../src/tools/migration.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "migration-app");

const SAVED_REAM_ENV = process.env.REAM_ENV;
const SAVED_NODE_ENV = process.env.NODE_ENV;

let tmpDbDir: string;

beforeEach(() => {
	tmpDbDir = mkdtempSync(join(tmpdir(), "migration-rollback-"));
	process.env.REAM_DATABASE_URL = `sqlite://${join(tmpDbDir, "test.db")}?mode=rwc`;
	delete process.env.REAM_ENV;
	delete process.env.NODE_ENV;
});

afterEach(() => {
	delete process.env.REAM_DATABASE_URL;
	rmSync(tmpDbDir, { recursive: true, force: true });
	if (SAVED_REAM_ENV === undefined) delete process.env.REAM_ENV;
	else process.env.REAM_ENV = SAVED_REAM_ENV;
	if (SAVED_NODE_ENV === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = SAVED_NODE_ENV;
});

interface DryRollbackShape {
	wouldRollback: Array<{
		id: string;
		name: string;
		sql: string;
		batch: number;
	}>;
	confidence: "high" | "medium" | "low";
	knownGaps: string[];
}

interface RolledBackShape {
	rolledBack: Array<{ id: string; name: string; batch: number }>;
}

async function applyMigrations(): Promise<void> {
	await dispatchMigration(FIXTURE, "migration.run", {
		dryRun: false,
		confirm: true,
	});
}

describe("migration > rollback", () => {
	it("returns wouldRollback with reverse SQL for the last batch (dry-run)", async () => {
		await applyMigrations();
		const result = (await dispatchMigration(FIXTURE, "migration.rollback", {
			dryRun: true,
		})) as DryRollbackShape;
		expect(result.wouldRollback.length).toBe(2);
		// Reverse SQL is DROP TABLE for both fixtures.
		expect(result.wouldRollback[0].sql).toContain("DROP TABLE");
		expect(result.wouldRollback.every((r) => r.batch === 1)).toBe(true);
	});

	it("refuses dryRun:false without confirm:true", async () => {
		await applyMigrations();
		const result = (await dispatchMigration(FIXTURE, "migration.rollback", {
			dryRun: false,
		})) as { error: string; confidence: string };
		expect(result.error).toContain("confirm: true required");
		expect(result.confidence).toBe("low");
	});

	it("actually rolls back when dryRun:false + confirm:true", async () => {
		await applyMigrations();
		const result = (await dispatchMigration(FIXTURE, "migration.rollback", {
			dryRun: false,
			confirm: true,
		})) as RolledBackShape;
		expect(result.rolledBack.length).toBe(2);
		// Status now shows everything pending again.
		const status = (await dispatchMigration(FIXTURE, "migration.status")) as {
			applied: unknown[];
			pending: unknown[];
		};
		expect(status.applied).toEqual([]);
		expect(status.pending.length).toBe(2);
	});

	it("silently caps `step` when it exceeds applied batches", async () => {
		await applyMigrations();
		const result = (await dispatchMigration(FIXTURE, "migration.rollback", {
			dryRun: true,
			step: 99,
		})) as DryRollbackShape;
		// Only one batch was applied; cap to that.
		expect(result.wouldRollback.length).toBe(2);
	});

	it("rejects non-positive integer step", async () => {
		const result = (await dispatchMigration(FIXTURE, "migration.rollback", {
			step: 0,
		})) as { error: string; confidence: string };
		expect(result.error).toContain("invalid step");
		expect(result.confidence).toBe("low");
	});
});
