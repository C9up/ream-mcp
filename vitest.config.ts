import { platform } from "node:process";
import { defineConfig } from "vitest/config";

// Tests that open a real @c9up/atlas `db.node` connection hang vitest on
// Windows: atlas's shared tokio runtime is never released, so the worker that
// touched it can't terminate and the run never finalises (no summary printed).
// This is an upstream atlas/db.node issue (its own win32 CI never opens a real
// connection). Exclude the atlas-connection suites on win32 only — they run on
// Linux + macOS. Remove once atlas releases its runtime on process exit.
const win32AtlasSkips =
	platform === "win32"
		? [
				"tests/unit/atlas-bridge.test.ts",
				"tests/integration/migration-run.test.ts",
				"tests/integration/migration-rollback.test.ts",
				"tests/integration/migration-status.test.ts",
				"tests/integration/migration-prod-guard.test.ts",
			]
		: [];

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		exclude: ["**/node_modules/**", "tests/fixtures/**", ...win32AtlasSkips],
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
