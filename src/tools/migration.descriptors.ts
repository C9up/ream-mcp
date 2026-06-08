/**
 * Lightweight tool-list descriptors for `migration.*` (Story 33.6).
 *
 * Same descriptor / handler split as 33.3 / 33.4 / 33.5: this
 * file holds the JSON schemas only and is statically imported by
 * `server.ts`. The heavy `migration.ts` dispatcher (which
 * dynamic-imports `@c9up/atlas`) is dynamic-imported on first
 * call so the cold-boot path stays under 250 ms (cerebrum: heavy
 * CJS imports race SIGTERM).
 *
 * Note: `@c9up/atlas` is declared as a `peerDependency` of
 * `@c9up/ream-mcp` — the consumer's installed Atlas drives
 * runtime migrations so the bundled migration files match. This
 * is a deliberate exception to the "no cross-package imports"
 * rule (cerebrum) because in-process bridging into Atlas is the
 * whole point of Story 33.6.
 *
 * Deliberate scope cuts (Story 33.6 spec):
 *  - No `migration.refresh` (down-then-up cascade) — would require
 *    a holistic rollback story; defer to a future epic.
 *  - No N-step migrate-up — Atlas applies all pending in one
 *    batch by design; partial up-runs would break the batch
 *    invariant.
 *  - Per-migration timing in `migrate`/`rollback` is the loop
 *    wall-time averaged across migrations applied in the call —
 *    NOT measured per-statement. Treat as approximate.
 */

interface ToolDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export const MIGRATION_TOOLS: ToolDescriptor[] = [
	{
		name: "migration.status",
		description:
			"Inspect Atlas migration state — returns `{ applied: [{ id, name, ranAt }], pending: [{ id, name, file }], currentBatch }` sorted by id ascending. On the very first call against a fresh database the `_migrations` tracking table is created (Atlas runner contract); subsequent calls are read-only.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "migration.run",
		description:
			"Run pending Atlas migrations. Dry-run by default — `dryRun: true` (default) returns `{ wouldRun: [{ id, name, sql }] }` and does NOT execute migration SQL, but on the very first call against a fresh DB the Atlas runner still creates the `_migrations` tracking table. `dryRun: false` requires `confirm: true` (strict-consent rule from 33.4) and runs migrations inside Atlas's transactional batch contract — atomic bookkeeping. When `NODE_ENV`/`REAM_ENV` is `production`, BOTH `confirm: true` AND `allowProduction: true` are required.",
		inputSchema: {
			type: "object",
			properties: {
				dryRun: {
					type: "boolean",
					default: true,
					description:
						"When true (default), preview the SQL without applying. When false, requires `confirm: true` to run.",
				},
				confirm: {
					type: "boolean",
					default: false,
					description:
						"Required when dryRun is false. Prevents accidental schema changes from a stray dry-run flip.",
				},
				env: {
					type: "string",
					description:
						"Override env detection (lowest priority — REAM_ENV / NODE_ENV process env vars win first).",
				},
				allowProduction: {
					type: "boolean",
					default: false,
					description:
						"Second flag required when running against production. Single-flag misconfiguration is refused.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "migration.rollback",
		description:
			"Roll back the last `step` (default 1) Atlas migration BATCHES. Dry-run by default — returns the reverse SQL that would execute. `step` is a count of batches, not migrations: one batch may contain multiple migrations and rolls back as a unit. When `step` exceeds the number of applied batches, it's silently capped. Production guard same as `migration.run`.",
		inputSchema: {
			type: "object",
			properties: {
				step: {
					type: "integer",
					minimum: 1,
					default: 1,
					description:
						"Number of batches to roll back. Capped at applied count.",
				},
				dryRun: {
					type: "boolean",
					default: true,
					description:
						"When true (default), preview the reverse SQL without applying. When false, requires `confirm: true`.",
				},
				confirm: {
					type: "boolean",
					default: false,
					description: "Required when dryRun is false.",
				},
				env: {
					type: "string",
					description: "Override env detection (lowest priority).",
				},
				allowProduction: {
					type: "boolean",
					default: false,
					description:
						"Second flag required when rolling back against production.",
				},
			},
			additionalProperties: false,
		},
	},
];

const NAMES = new Set(MIGRATION_TOOLS.map((t) => t.name));

export function isMigrationTool(name: string): boolean {
	return NAMES.has(name);
}
