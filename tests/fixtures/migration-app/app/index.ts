// FIXTURE — minimal entry so the package walker can resolve a
// main entry. The migration tools don't need source files; the
// fixture's reason for existence is the `database/migrations/`
// directory.

export const MARKER = "migration-app-fixture";
