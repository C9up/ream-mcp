import { platform } from "node:process";
import { defineConfig } from "vitest/config";

// published-shape packs the tarball with `pnpm pack` then inspects it with
// `tar`/`gzip`. That tooling chain is unreliable on the win32 runner (bsdtar +
// gzip stream quirks), and the tarball shape it verifies is platform-independent
// (covered on Linux + macOS). Skip it on win32 — same call as @c9up/inker.
const win32Skips =
	platform === "win32" ? ["tests/integration/published-shape.test.ts"] : [];

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
