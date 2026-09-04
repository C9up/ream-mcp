import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		exclude: ["**/node_modules/**", "tests/fixtures/**"],
		// Integration tests spawn child processes — give them headroom
		// over the default 5s timeout for stdio bring-up.
		testTimeout: 15_000,
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text-summary", "json-summary"],
			// Set from what CI reaches, not what a workspace checkout does:
			// `generate-real-cli` needs the ream-cli sibling and `bmad.*` need a
			// _bmad-output fixture, and both skip in a standalone repository —
			// which is where this gate runs. Locally the same suite covers ~2
			// points more.
			thresholds: {
				lines: 76,
				statements: 73,
				branches: 61,
				functions: 80,
			},
		},
	},
});
