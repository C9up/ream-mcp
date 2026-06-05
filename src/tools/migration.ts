/**
 * `migration.*` MCP tools — Story 33.6.
 *
 * Bridge into Atlas's `MigrationRunner` in-process for the
 * highest-stakes write surface in the MCP server: schema
 * migrations. Three guardrails:
 *
 *   1. Dry-run by default (preview SQL, never mutate).
 *   2. Strict consent (33.4 G6) — `dryRun: false` requires
 *      `confirm: true`.
 *   3. Production double-flag — when REAM_ENV/NODE_ENV is
 *      `production`, BOTH `confirm: true` AND
 *      `allowProduction: true` are required.
 *
 * Per-dispatch adapter lifecycle: every call builds a fresh
 * connection and `close()`s it in `finally`. No pool reuse.
 *
 * Heavy CJS imports (`@c9up/atlas`) are dynamic-imported by
 * `util/atlas-bridge.ts` so the cold-boot path stays under
 * 250 ms.
 */

import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import type {
	DatabaseAdapter,
	Migration,
	MigrationRecord,
	MigrationRunner,
} from "@c9up/atlas";

import {
	type BridgeResult,
	buildAtlasBridge,
	type Dialect,
	isBridgeError,
	splitMigrationName,
} from "../util/atlas-bridge.js";
import { checkConsent } from "../util/env-guard.js";

export {
	isMigrationTool,
	MIGRATION_TOOLS,
} from "./migration.descriptors.js";

type Confidence = "high" | "medium" | "low";

const MIGRATIONS_TABLE = "_migrations";

interface ConsentInputs {
	dryRun: boolean;
	confirm: boolean;
	env?: string;
	allowProduction: boolean;
}

export async function dispatchMigration(
	root: string,
	name: string,
	args: Record<string, unknown> = {},
): Promise<unknown> {
	switch (name) {
		case "migration.status":
			return runStatus(root);
		case "migration.run":
			return runMigrate(root, args);
		case "migration.rollback":
			return runRollback(root, args);
		default:
			return shapeError(`Unknown migration tool: ${name}`, "");
	}
}

// --------------------------------------------------------- envelopes

function shapeError(
	error: string,
	hint: string,
): {
	error: string;
	hint: string;
	confidence: Confidence;
	knownGaps: string[];
} {
	return { error, hint, confidence: "low", knownGaps: [] };
}

function wrap<T extends Record<string, unknown>>(
	body: T,
	knownGaps: string[],
): T & { confidence: Confidence; knownGaps: string[] } {
	return {
		...body,
		confidence: knownGaps.length === 0 ? "high" : "medium",
		knownGaps,
	};
}

// ----------------------------------------------------------- status

async function runStatus(root: string): Promise<unknown> {
	const bridge = await buildAtlasBridge({ root });
	if (isBridgeError(bridge)) return shapeError(bridge.error, bridge.hint);
	const knownGaps: string[] = [];

	if (!bridge.migrationsDirExists) {
		// A fresh project with no migrations yet is not a failure —
		// surface the empty result with a gap so the caller knows
		// which path was taken.
		const relDir = toForwardSlash(relative(root, bridge.migrationsDir));
		await safeClose(bridge);
		return wrap(
			{
				applied: [] as Array<{ id: string; name: string; ranAt: string }>,
				pending: [] as Array<{ id: string; name: string; file: string }>,
				currentBatch: 0,
			},
			[`migrations directory not found at ${relDir}`],
		);
	}

	if (!bridge.supportsTransactions) {
		knownGaps.push(
			"DatabaseAdapter does not support runInTransaction — atomicity is best-effort",
		);
	}

	try {
		const runner = bridge.runner as MigrationRunner;
		await runner.init();
		const statuses = await runner.status();
		const applied: Array<{ id: string; name: string; ranAt: string }> = [];
		const pending: Array<{ id: string; name: string; file: string }> = [];
		const appliedNames = statuses
			.filter((s) => s.status === "applied")
			.map((s) => s.name);
		const records = appliedNames.length
			? await readAppliedRecords(bridge.connection as DatabaseAdapter)
			: new Map<string, string>();

		for (const s of statuses) {
			const split = splitMigrationName(s.name);
			if (s.status === "applied") {
				applied.push({
					id: split.id,
					name: split.name,
					ranAt: records.get(s.name) ?? "",
				});
			} else {
				const file = pickMigrationFile(bridge.migrationsDir, s.name);
				pending.push({
					id: split.id,
					name: split.name,
					file: toForwardSlash(relative(root, file)),
				});
			}
		}

		applied.sort((a, b) => a.id.localeCompare(b.id));
		pending.sort((a, b) => a.id.localeCompare(b.id));
		const currentBatch = statuses.reduce(
			(max, s) =>
				typeof s.batch === "number" && s.batch > max ? s.batch : max,
			0,
		);
		return wrap({ applied, pending, currentBatch }, knownGaps);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return shapeError("migration.status failed", detail);
	} finally {
		await safeClose(bridge);
	}
}

async function readAppliedRecords(
	adapter: DatabaseAdapter,
): Promise<Map<string, string>> {
	const rows = await adapter.query<MigrationRecord>(
		`SELECT name, executed_at FROM ${MIGRATIONS_TABLE}`,
	);
	const map = new Map<string, string>();
	for (const r of rows) {
		map.set(r.name, String(r.executed_at ?? ""));
	}
	return map;
}

// Prefer compiled artifacts over sources: when a project ships
// both `.ts` (sources) and `.js` (compiled), Atlas runtime expects
// the compiled artifact. Falling back to `.ts` lets dev workflows
// (tsx) still resolve.
const MIGRATION_EXTENSIONS: readonly string[] = [".js", ".cjs", ".mjs", ".ts"];

function pickMigrationFile(migrationsDir: string, baseName: string): string {
	for (const ext of MIGRATION_EXTENSIONS) {
		const candidate = join(migrationsDir, `${baseName}${ext}`);
		if (existsSync(candidate)) return candidate;
	}
	// No file present — return the canonical `.js` path so the
	// downstream import error mentions the expected layout.
	return join(migrationsDir, `${baseName}.js`);
}

// -------------------------------------------------------------- run

async function runMigrate(
	root: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const inputs = parseConsentInputs(args, true);
	if ("error" in inputs) return shapeError(inputs.error, inputs.hint);

	if (!inputs.dryRun) {
		const refusal = checkConsent(inputs);
		if (refusal) return shapeError(refusal.error, refusal.hint);
	}

	const bridge = await buildAtlasBridge({ root });
	if (isBridgeError(bridge)) return shapeError(bridge.error, bridge.hint);
	if (!bridge.migrationsDirExists) {
		const relDir = toForwardSlash(relative(root, bridge.migrationsDir));
		await safeClose(bridge);
		return shapeError(
			`migrations directory not found at ${relDir}`,
			"create database/migrations/ or set REAM_MIGRATIONS_DIR before running migrations",
		);
	}
	const knownGaps: string[] = [];
	if (!bridge.supportsTransactions) {
		knownGaps.push(
			"DatabaseAdapter does not support runInTransaction — atomicity is best-effort",
		);
	}

	try {
		const runner = bridge.runner as MigrationRunner;
		if (inputs.dryRun) {
			const plan = await runner.dryRun();
			const wouldRun = plan.map((m) => {
				const split = splitMigrationName(m.name);
				return {
					id: split.id,
					name: split.name,
					sql: m.sql.join(";\n") + (m.sql.length > 0 ? ";" : ""),
				};
			});
			return wrap({ wouldRun }, knownGaps);
		}

		const start = performance.now();
		const executed = await runner.migrate();
		const totalMs = performance.now() - start;
		const perMigrationMs =
			executed.length > 0 ? Math.round(totalMs / executed.length) : 0;
		const ran = executed.map((name) => {
			const split = splitMigrationName(name);
			return {
				id: split.id,
				name: split.name,
				durationMs: perMigrationMs,
			};
		});
		return wrap({ ran }, knownGaps);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return shapeError("migration.run failed", detail);
	} finally {
		await safeClose(bridge);
	}
}

// --------------------------------------------------------- rollback

async function runRollback(
	root: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const stepRaw = args.step;
	const step = stepRaw === undefined ? 1 : stepRaw;
	if (typeof step !== "number" || !Number.isInteger(step) || step < 1) {
		return shapeError(
			"invalid step",
			`step must be a positive integer (default 1); received ${JSON.stringify(stepRaw)}.`,
		);
	}

	const inputs = parseConsentInputs(args, true);
	if ("error" in inputs) return shapeError(inputs.error, inputs.hint);

	if (!inputs.dryRun) {
		const refusal = checkConsent(inputs);
		if (refusal) return shapeError(refusal.error, refusal.hint);
	}

	const bridge = await buildAtlasBridge({ root });
	if (isBridgeError(bridge)) return shapeError(bridge.error, bridge.hint);
	if (!bridge.migrationsDirExists) {
		const relDir = toForwardSlash(relative(root, bridge.migrationsDir));
		await safeClose(bridge);
		return shapeError(
			`migrations directory not found at ${relDir}`,
			"create database/migrations/ or set REAM_MIGRATIONS_DIR before rolling back",
		);
	}
	const knownGaps: string[] = [];
	if (!bridge.supportsTransactions) {
		knownGaps.push(
			"DatabaseAdapter does not support runInTransaction — atomicity is best-effort",
		);
	}

	try {
		const runner = bridge.runner as MigrationRunner;
		await runner.init();

		if (inputs.dryRun) {
			const wouldRollback = await previewRollback(bridge, step);
			return wrap({ wouldRollback }, knownGaps);
		}

		const rolledBack: Array<{ id: string; name: string; batch: number }> = [];
		for (let i = 0; i < step; i++) {
			const adapter = bridge.connection as DatabaseAdapter;
			const before = await currentBatch(adapter);
			if (before === 0) break;
			const names = await runner.rollback();
			for (const n of names) {
				const split = splitMigrationName(n);
				rolledBack.push({ id: split.id, name: split.name, batch: before });
			}
		}
		return wrap({ rolledBack }, knownGaps);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return shapeError("migration.rollback failed", detail);
	} finally {
		await safeClose(bridge);
	}
}

async function previewRollback(
	bridge: BridgeResult,
	step: number,
): Promise<Array<{ id: string; name: string; sql: string; batch: number }>> {
	const adapter = bridge.connection as DatabaseAdapter;
	const max = await currentBatch(adapter);
	if (max === 0) return [];
	const targetBatches = [];
	for (let b = max; b > Math.max(0, max - step); b--) targetBatches.push(b);

	const out: Array<{ id: string; name: string; sql: string; batch: number }> =
		[];
	for (const batch of targetBatches) {
		const rows = await adapter.query<MigrationRecord>(
			`SELECT name, batch FROM ${MIGRATIONS_TABLE} WHERE batch = ? ORDER BY name DESC`,
			[batch],
		);
		for (const r of rows) {
			const sql = await loadDownSql(
				bridge.migrationsDir,
				r.name,
				bridge.dialect,
			);
			const split = splitMigrationName(r.name);
			out.push({
				id: split.id,
				name: split.name,
				sql,
				batch,
			});
		}
	}
	return out;
}

async function loadDownSql(
	migrationsDir: string,
	name: string,
	dialect: Dialect,
): Promise<string> {
	const filePath = pickMigrationFile(migrationsDir, name);
	// Defense-in-depth: even though `name` originates from the
	// internal `_migrations` table, treat it as untrusted and
	// refuse anything that escapes `migrationsDir`.
	const dirAbs = resolve(migrationsDir);
	const fileAbs = resolve(filePath);
	if (!fileAbs.startsWith(dirAbs + sep) && fileAbs !== dirAbs) {
		throw new Error(`migration filename escapes migrations directory: ${name}`);
	}
	// `pathToFileURL` produces a valid `file://` URL on every
	// platform — required for dynamic-import on Windows and
	// safer than ad-hoc string concatenation.
	const mod = (await import(pathToFileURL(fileAbs).href)) as {
		default?: new (dialect?: string) => Migration;
	};
	const MigrationClass = mod.default;
	if (!MigrationClass) return "";
	// Pass the bridge's dialect so the compiled SQL matches what
	// `MigrationRunner` would have emitted on the apply path.
	const instance = new MigrationClass(dialect);
	const stmts = await instance.getDownSQL();
	return stmts.join(";\n") + (stmts.length > 0 ? ";" : "");
}

// Returns the latest batch number applied to the DB, or 0 when no
// migration has run yet. The wire shape of `migration.status`
// distinguishes the two via `currentBatch === 0` (no batches) — a
// valid batch is always >= 1 in Atlas's contract.
async function currentBatch(adapter: DatabaseAdapter): Promise<number> {
	const rows = await adapter.query<{ max: number | null }>(
		`SELECT MAX(batch) AS max FROM ${MIGRATIONS_TABLE}`,
	);
	const v = rows[0]?.max;
	return typeof v === "number" ? v : 0;
}

// ---------------------------------------------------------- helpers

interface ConsentInputsError {
	error: string;
	hint: string;
}

function parseConsentInputs(
	args: Record<string, unknown>,
	dryRunDefault: boolean,
): ConsentInputs | ConsentInputsError {
	const dryRun = args.dryRun === undefined ? dryRunDefault : args.dryRun;
	if (typeof dryRun !== "boolean") {
		return { error: "invalid dryRun", hint: "dryRun must be a boolean" };
	}
	const confirm = args.confirm === undefined ? false : args.confirm;
	if (typeof confirm !== "boolean") {
		return { error: "invalid confirm", hint: "confirm must be a boolean" };
	}
	const allowProduction =
		args.allowProduction === undefined ? false : args.allowProduction;
	if (typeof allowProduction !== "boolean") {
		return {
			error: "invalid allowProduction",
			hint: "allowProduction must be a boolean",
		};
	}
	let env: string | undefined;
	if (args.env !== undefined) {
		if (typeof args.env !== "string") {
			return { error: "invalid env", hint: "env must be a string" };
		}
		env = args.env;
	}
	if (dryRun && confirm) {
		// `confirm: true` is meaningless during a dry-run — the
		// caller has likely set both by accident. Refusing here
		// surfaces the misconfiguration before it leaks into a
		// real run on a future flip.
		return {
			error: "contradictory inputs: dryRun and confirm both true",
			hint: "set dryRun: false when passing confirm: true; preview-only calls do not need confirm",
		};
	}
	return { dryRun, confirm, allowProduction, env };
}

async function safeClose(bridge: BridgeResult): Promise<void> {
	try {
		await bridge.connection.close();
	} catch (err) {
		// Atlas's close() can throw on already-closed connections;
		// nothing to recover from in the dispatcher, but surface
		// the diagnostic on stderr so an operator can correlate with
		// sqlx panics in the host process.
		const detail = err instanceof Error ? err.message : String(err);
		console.error(`[ream-mcp] migration bridge close failed: ${detail}`);
	}
}

function toForwardSlash(p: string): string {
	return p.replace(/\\/g, "/");
}
