/**
 * Shared types for `security.scan` checks (Story 33.7).
 *
 * Each check is a small ts-morph visitor co-located in this
 * directory. The dispatcher in `tools/security.ts` walks every
 * eligible source file once and fans each file out across the
 * registered checks. Findings produced here are normalized into
 * the MCP wire shape by the dispatcher (severity / hint /
 * docsUrl come from the `CheckDefinition` table; `id` is a
 * sha1-derived stable identifier so re-runs collide).
 */

import type { Project, SourceFile } from "ts-morph";

import type { SecurityCheckId } from "../../tools/security.descriptors.js";

export type Severity = "critical" | "high" | "medium" | "low";

export interface CheckContext {
	sf: SourceFile;
	relPath: string;
	project: Project;
	root: string;
	/**
	 * Forward-slash relative path of the resolved entry file
	 * (priority order: `src/main.ts` → `src/index.ts` →
	 * `src/bootstrap.ts` → `main.ts` → `index.ts`), or `null`
	 * when the consumer ships none of those. Pre-computed once
	 * per dispatch so per-file checks don't re-stat. Only the
	 * `reflect_metadata_missing` check uses it.
	 */
	entryFile: string | null;
}

export interface RawFinding {
	check: SecurityCheckId;
	line: number;
	excerpt: string;
}

export interface CheckDefinition {
	id: SecurityCheckId;
	severity: Severity;
	hint: string;
	docsUrl: string;
	run(ctx: CheckContext): RawFinding[];
}

/**
 * Severity table — fixed by the story spec, NOT inferred. Past
 * audits drifted when severities became "feels like a high"
 * judgements.
 */
export const SEVERITY_RANK: Record<Severity, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};
