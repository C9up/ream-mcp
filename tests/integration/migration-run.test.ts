/**
 * `migration.run` integration tests — Story 33.6.
 *
 * Drives the dry-run preview path, the strict-consent refusal,
 * and the actual `confirm: true` execution against a tmp-file
 * sqlite DB shared across the test's calls.
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
	tmpDbDir = mkdtempSync(join(tmpdir(), "migration-run-"));
	process.env.REAM_DATABASE_URL = `sqlite://${join(tmpDbDir, "test.db")}?mode=rwc`;
	// Pin a known non-production env so a developer running
	// `REAM_ENV=production pnpm exec vitest` doesn't trip the
	// production double-flag guard in non-prod-guard suites.
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

interface DryRunShape {
	wouldRun: Array<{ id: string; name: string; sql: string }>;
	confidence: "high" | "medium" | "low";
	knownGaps: string[];
}

interface RunShape {
	ran: Array<{ id: string; name: string; durationMs: number }>;
	confidence: "high" | "medium" | "low";
	knownGaps: string[];
}

interface ErrorShape {
	error: string;
	hint: string;
	confidence: "low";
	knownGaps: string[];
}

describe("migration > run", () => {
	it("returns wouldRun with SQL for both pending migrations on dry-run", async () => {
		const result = (await dispatchMigration(FIXTURE, "migration.run", {
			dryRun: true,
		})) as DryRunShape;
		expect(result.wouldRun.length).toBe(2);
		expect(result.wouldRun[0].id).toBe("1700000000_create_users");
		expect(result.wouldRun[0].sql).toContain("CREATE TABLE");
		expect(result.wouldRun[0].sql).toContain("users");
		expect(result.wouldRun[1].sql).toContain("posts");
	});

	it("refuses dryRun:false without confirm:true", async () => {
		const result = (await dispatchMigration(FIXTURE, "migration.run", {
			dryRun: false,
		})) as ErrorShape;
		expect(result.error).toContain("confirm: true required");
		expect(result.confidence).toBe("low");
	});

	it("actually applies migrations when dryRun:false + confirm:true", async () => {
		const ran = (await dispatchMigration(FIXTURE, "migration.run", {
			dryRun: false,
			confirm: true,
		})) as RunShape;
		expect(ran.ran.length).toBe(2);
		expect(ran.ran.map((r) => r.name)).toEqual([
			"create_users",
			"create_posts",
		]);
		// Status now reflects the applied state.
		const status = (await dispatchMigration(FIXTURE, "migration.status")) as {
			applied: Array<{ name: string }>;
			pending: Array<{ name: string }>;
			currentBatch: number;
		};
		expect(status.pending).toEqual([]);
		expect(status.applied.map((a) => a.name).sort()).toEqual([
			"create_posts",
			"create_users",
		]);
		expect(status.currentBatch).toBe(1);
	});

	it("rejects non-boolean dryRun with a structured error", async () => {
		const result = (await dispatchMigration(FIXTURE, "migration.run", {
			dryRun: "yes",
		})) as ErrorShape;
		expect(result.error).toContain("dryRun");
	});
});
