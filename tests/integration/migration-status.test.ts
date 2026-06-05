/**
 * `migration.status` integration tests — Story 33.6.
 *
 * Drives the dispatcher against the migration-app fixture with a
 * fresh tmp-file sqlite DB per test (in-process via Atlas's NAPI
 * driver). `sqlite::memory:` would create a brand-new DB on every
 * connection, so we use a file-backed URL so the dispatcher's
 * fresh-adapter-per-call lifecycle still observes prior writes.
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
	tmpDbDir = mkdtempSync(join(tmpdir(), "migration-status-"));
	// `sqlite:///<abs>?mode=rwc` opens-or-creates the file. Plain
	// `sqlite:<abs>` fails on sqlx with "unable to open" because it
	// expects the file to exist.
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

interface StatusShape {
	applied: Array<{ id: string; name: string; ranAt: string }>;
	pending: Array<{ id: string; name: string; file: string }>;
	currentBatch: number;
	confidence: "high" | "medium" | "low";
	knownGaps: string[];
}

describe("migration > status", () => {
	it("lists all migrations as pending on a fresh DB", async () => {
		const result = (await dispatchMigration(
			FIXTURE,
			"migration.status",
		)) as StatusShape;
		expect(result.applied).toEqual([]);
		expect(result.pending.length).toBe(2);
		expect(result.pending[0].name).toBe("create_users");
		expect(result.pending[0].id).toBe("1700000000_create_users");
		expect(result.pending[0].file.endsWith("1700000000_create_users.ts")).toBe(
			true,
		);
		expect(result.currentBatch).toBe(0);
	});

	it("returns empty applied/pending and a knownGap when migrations dir is missing", async () => {
		// Point migrationsDir at a non-existent path; the dispatcher
		// surfaces a knownGap rather than an error.
		process.env.REAM_MIGRATIONS_DIR = join(tmpDbDir, "no-such-dir");
		try {
			const result = (await dispatchMigration(
				FIXTURE,
				"migration.status",
			)) as StatusShape;
			expect(result.applied).toEqual([]);
			expect(result.pending).toEqual([]);
			expect(result.currentBatch).toBe(0);
			expect(result.confidence).toBe("medium");
			expect(result.knownGaps[0]).toContain("migrations directory not found");
		} finally {
			delete process.env.REAM_MIGRATIONS_DIR;
		}
	});

	it("returns the structured no-DB-URL error when env vars are unset", async () => {
		delete process.env.REAM_DATABASE_URL;
		const result = (await dispatchMigration(FIXTURE, "migration.status")) as {
			error: string;
			hint: string;
			confidence: string;
		};
		expect(result.error).toContain("no database URL configured");
		expect(result.confidence).toBe("low");
	});
});
