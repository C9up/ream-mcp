/**
 * Project-root detection — covers all 4 detection branches +
 * env override + no-root error path. Uses a tmp directory tree
 * per test to avoid bleed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectProjectRoot } from "../../src/util/project-root.js";

let workDir: string;
let envBackup: string | undefined;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "ream-mcp-test-"));
	envBackup = process.env.REAM_PROJECT_ROOT;
	delete process.env.REAM_PROJECT_ROOT;
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
	if (envBackup === undefined) {
		delete process.env.REAM_PROJECT_ROOT;
	} else {
		process.env.REAM_PROJECT_ROOT = envBackup;
	}
});

describe("detectProjectRoot — env override", () => {
	it("REAM_PROJECT_ROOT short-circuits the walk", () => {
		process.env.REAM_PROJECT_ROOT = "/tmp/some/path";
		expect(detectProjectRoot(workDir)).toEqual({
			path: "/tmp/some/path",
			source: "env",
		});
	});
});

describe("detectProjectRoot — file markers", () => {
	it("finds reamrc.ts in cwd", () => {
		writeFileSync(join(workDir, "reamrc.ts"), "export default {}");
		expect(detectProjectRoot(workDir)).toEqual({
			path: workDir,
			source: "reamrc.ts",
		});
	});

	it("finds reamrc.ts walking up from a nested dir", () => {
		writeFileSync(join(workDir, "reamrc.ts"), "export default {}");
		const nested = join(workDir, "src", "modules", "x");
		mkdirSync(nested, { recursive: true });
		expect(detectProjectRoot(nested)).toEqual({
			path: workDir,
			source: "reamrc.ts",
		});
	});

	it("falls back to ream.config.ts (legacy alias)", () => {
		writeFileSync(join(workDir, "ream.config.ts"), "export default {}");
		expect(detectProjectRoot(workDir)).toEqual({
			path: workDir,
			source: "ream.config.ts",
		});
	});

	it("prefers reamrc.ts over ream.config.ts when both exist", () => {
		writeFileSync(join(workDir, "reamrc.ts"), "export default {}");
		writeFileSync(join(workDir, "ream.config.ts"), "export default {}");
		expect(detectProjectRoot(workDir)).toEqual({
			path: workDir,
			source: "reamrc.ts",
		});
	});

	it("finds package.json with @c9up/ream in dependencies", () => {
		writeFileSync(
			join(workDir, "package.json"),
			JSON.stringify({
				name: "demo-app",
				dependencies: { "@c9up/ream": "^0.1.0" },
			}),
		);
		expect(detectProjectRoot(workDir)).toEqual({
			path: workDir,
			source: "package.json",
		});
	});

	it("finds package.json with @c9up/ream in devDependencies", () => {
		writeFileSync(
			join(workDir, "package.json"),
			JSON.stringify({
				name: "demo-app",
				devDependencies: { "@c9up/ream": "^0.1.0" },
			}),
		);
		expect(detectProjectRoot(workDir).source).toBe("package.json");
	});

	it("finds package.json with @c9up/ream in peerDependencies", () => {
		writeFileSync(
			join(workDir, "package.json"),
			JSON.stringify({
				name: "demo-app",
				peerDependencies: { "@c9up/ream": "^0.1.0" },
			}),
		);
		expect(detectProjectRoot(workDir).source).toBe("package.json");
	});

	it("ignores package.json without @c9up/ream", () => {
		writeFileSync(
			join(workDir, "package.json"),
			JSON.stringify({ name: "demo-app", dependencies: { lodash: "^4" } }),
		);
		expect(() => detectProjectRoot(workDir)).toThrow(
			/cannot detect a Ream project root/,
		);
	});
});

describe("detectProjectRoot — no marker found", () => {
	it("throws a structured error mentioning REAM_PROJECT_ROOT", () => {
		expect(() => detectProjectRoot(workDir)).toThrow(/REAM_PROJECT_ROOT/);
	});

	it("error mentions all 3 marker names", () => {
		try {
			detectProjectRoot(workDir);
			expect.fail("should have thrown");
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toContain("reamrc.ts");
			expect(msg).toContain("ream.config.ts");
			expect(msg).toContain("@c9up/ream");
		}
	});

	it("error mentions the cwd that was walked", () => {
		expect(() => detectProjectRoot(workDir)).toThrow(workDir);
	});
});
