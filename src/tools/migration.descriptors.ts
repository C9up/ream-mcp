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

import { DESTRUCTIVE, READ_ONLY, type ToolDescriptor } from "./descriptor.js";

const WRITE_GATE =
	"`dryRun: false` also needs `confirm: true`, and is refused unless the user launched the server with `REAM_MCP_ALLOW_MIGRATIONS=1`. A target that is production — `REAM_ENV`/`NODE_ENV` is `production`, or the database URL is not provably local (a sqlite file inside the project, or a loopback / unix-socket server) — further needs `REAM_MCP_ALLOW_PRODUCTION_MIGRATIONS=1` at launch. No tool argument can enable writes.";

const PREVIEW_RUNS_CODE =
	"The preview is not side-effect free: to compute the SQL it imports each migration module (running its top-level code) and calls its";

export const MIGRATION_TOOLS: ToolDescriptor[] = [
	{
		name: "migration.status",
		annotations: READ_ONLY,
		description:
			"Inspect Atlas migration state — returns `{ applied: [{ id, name, ranAt }], pending: [{ id, name, file }], currentBatch }` sorted by id ascending. Read-only: it never creates the tracking table; on a database that was never migrated every migration is pending and a knownGap says the table is not initialised.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "migration.run",
		annotations: DESTRUCTIVE,
		description: `Run pending Atlas migrations. Dry-run by default — \`dryRun: true\` (default) returns \`{ wouldRun: [{ id, name, sql }] }\` without applying the SQL. ${PREVIEW_RUNS_CODE} \`up()\` in this server process with the database connection bound, so a preview executes project code. ${WRITE_GATE} A real run applies migrations inside Atlas's transactional batch contract.`,
		inputSchema: {
			type: "object",
			properties: {
				dryRun: {
					type: "boolean",
					default: true,
					description:
						"When true (default), preview the SQL without applying it (the migration modules still run). When false, requires `confirm: true` and a server launched with writes enabled.",
				},
				confirm: {
					type: "boolean",
					default: false,
					description:
						"Required when dryRun is false. An accident guard, not an authorization.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "migration.rollback",
		annotations: DESTRUCTIVE,
		description: `Roll back the last \`step\` (default 1) Atlas migration BATCHES. Dry-run by default — returns the reverse SQL that would execute. ${PREVIEW_RUNS_CODE} \`down()\` in this server process, so a preview executes project code. \`step\` is a count of batches, not migrations: one batch may contain multiple migrations and rolls back as a unit. When \`step\` exceeds the number of applied batches, it's silently capped. ${WRITE_GATE}`,
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
						"When true (default), preview the reverse SQL without applying it (the migration modules still run). When false, requires `confirm: true` and a server launched with writes enabled.",
				},
				confirm: {
					type: "boolean",
					default: false,
					description:
						"Required when dryRun is false. An accident guard, not an authorization.",
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
