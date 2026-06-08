import { platform } from "node:process";
import { defineConfig } from "vitest/config";

// HYPOTHESIS PROBE: the migration.* integration tests open a real @c9up/atlas
// `db.node` connection. atlas's native tokio runtime isn't released on Windows
// (the original shared_runtime issue), leaving an open handle that hangs vitest
// at exit. Exclude them on win32 to confirm; if win32 then goes green, the leak
// is upstream in atlas, not ream-mcp.
const win32Skips =
	platform === "win32"
		? [
				"tests/integration/migration-run.test.ts",
				"tests/integration/migration-rollback.test.ts",
				"tests/integration/migration-status.test.ts",
				"tests/integration/migration-prod-guard.test.ts",
			]
		: [];

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		exclude: ["**/node_modules/**", "tests/fixtures/**", ...win32Skips],
		// Integration tests spawn child processes — give them headroom
		// over the default 5s timeout for stdio bring-up.
		testTimeout: 15_000,
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text-summary", "json-summary"],
			thresholds: {
				lines: 79,
				statements: 76,
				branches: 63,
				functions: 83,
			},
		},
	},
});
