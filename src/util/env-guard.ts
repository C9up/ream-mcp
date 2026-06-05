/**
 * Environment detection + consent gate for write-side
 * `migration.*` MCP tools — Story 33.6.
 *
 * Two responsibilities:
 *
 *   1. `detectEnv(override?)` — return the project's runtime
 *      environment, with a strict priority order. `REAM_ENV` is
 *      the explicit framework override, `NODE_ENV` is the
 *      12-factor convention, and the caller-provided `override`
 *      is the lowest priority (used so MCP clients can tag a
 *      sandbox call without setting process env).
 *
 *   2. `checkConsent(args)` — gate destructive operations behind
 *      the strict-consent rule (33.4 G6 carry-forward) plus the
 *      production double-flag rule introduced in 33.6:
 *
 *        - `dryRun: true`               → bypass (preview is safe).
 *        - `dryRun: false`, no confirm  → refuse.
 *        - production env, single flag  → refuse.
 *        - production env, both flags   → pass.
 *        - non-prod env, confirm: true  → pass.
 */

export type Env = "development" | "production" | "test" | string;

export interface ConsentArgs {
	dryRun: boolean;
	confirm: boolean;
	allowProduction: boolean;
	env?: string;
}

export interface ConsentRefusal {
	error: string;
	hint: string;
}

export function detectEnv(override?: string): Env {
	const reamEnv = process.env.REAM_ENV;
	if (typeof reamEnv === "string" && reamEnv.length > 0)
		return reamEnv.toLowerCase();
	const nodeEnv = process.env.NODE_ENV;
	if (typeof nodeEnv === "string" && nodeEnv.length > 0)
		return nodeEnv.toLowerCase();
	if (typeof override === "string" && override.length > 0)
		return override.toLowerCase();
	return "development";
}

export function checkConsent(args: ConsentArgs): ConsentRefusal | null {
	if (args.dryRun) return null;
	if (args.confirm !== true) {
		return {
			error: "confirm: true required",
			hint: "set confirm: true to actually run; pass dryRun: true to preview the SQL",
		};
	}
	const env = detectEnv(args.env);
	if (env === "production" && args.allowProduction !== true) {
		return {
			error:
				"production env requires both confirm:true and allowProduction:true",
			hint: "set allowProduction: true alongside confirm: true to operate against production",
		};
	}
	return null;
}
