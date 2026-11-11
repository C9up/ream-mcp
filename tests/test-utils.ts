/**
 * Test helpers shared across integration suites.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A committed project root holding a small `_bmad-output/` (epics.md,
 * sprint-status.yaml, one implementation artifact), so the `bmad.*` suites
 * run on every machine instead of depending on a live planning tree.
 */
export const BMAD_FIXTURE_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"bmad-root",
);
