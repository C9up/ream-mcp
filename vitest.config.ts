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
			// Set from what CI reaches on the host job, where every suite runs:
			// nothing skips (the CI gate fails a skipped test), and the
			// POSIX-only `*.posix.test.ts` files are excluded on Windows alone.
			thresholds: {
				lines: 76,
				statements: 73,
				branches: 61,
				functions: 80,
			},
		},
	},
});
