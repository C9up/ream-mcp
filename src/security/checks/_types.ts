/**
 * Shared types for `security.scan` checks.
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
import type { ProjectFacts } from "./_project.js";

export type Severity = "critical" | "high" | "medium" | "low";

export interface CheckContext {
	sf: SourceFile;
	relPath: string;
	project: Project;
	root: string;
	/**
	 * Where a check reports what it could not decide (a controller it could
	 * not follow, say) instead of guessing. The dispatcher returns them as the
	 * scan's `knownGaps`, which lowers its `confidence`.
	 */
	knownGaps: string[];
	/** The application as a whole: its ream version, its dependencies. */
	facts: ProjectFacts;
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
	/**
	 * Whether a file is one this check is about (a routes file, a blackhole
	 * config). A check that declares it and reads none of them says so in
	 * `knownGaps`: an empty answer would otherwise read as a clean one.
	 */
	appliesTo?(sf: SourceFile, relPath: string): boolean;
	/**
	 * The `knownGaps` line when no file it applies to was read, or `null` when
	 * the application has nothing to check (blackhole not installed, say).
	 */
	nothingRead?(facts: ProjectFacts): string | null;
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
