import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	resolveReamBin,
	runReamCli,
	sanitizeSpawnError,
} from "../../src/util/cli-runner.js";
import { canExecInTmp } from "../test-utils.js";

// Skip the whole suite on hardened CIs that mount /tmp with `noexec`.
// Every test here writes a Node stub under tmpdir() and spawns it,
// which surfaces as EPERM on those hosts even though the code under
// test is fine. The probe runs once per process and logs a stderr
// note explaining the skip.
const describeIfTmpExec = canExecInTmp() ? describe : describe.skip;

let tmpRoot: string;
let prevBin: string | undefined;
let prevNoShell: string | undefined;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "ream-mcp-cli-runner-"));
	prevBin = process.env.REAM_BIN;
	prevNoShell = process.env.REAM_MCP_NO_SHELL;
	delete process.env.REAM_BIN;
	delete process.env.REAM_MCP_NO_SHELL;
});

afterEach(() => {
	if (prevBin === undefined) delete process.env.REAM_BIN;
	else process.env.REAM_BIN = prevBin;
	if (prevNoShell === undefined) delete process.env.REAM_MCP_NO_SHELL;
	else process.env.REAM_MCP_NO_SHELL = prevNoShell;
	rmSync(tmpRoot, { recursive: true, force: true });
});

function writeStub(name: string, body: string): string {
	const path = join(tmpRoot, name);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

describeIfTmpExec("resolveReamBin", () => {
	it("prefers REAM_BIN env override", () => {
		const stub = writeStub("ream", "process.exit(0);");
		process.env.REAM_BIN = stub;
		expect(resolveReamBin(tmpRoot)).toBe(stub);
	});

	it("falls back to <root>/node_modules/.bin/ream", () => {
		const stub = writeStub("node_modules/.bin/ream", "process.exit(0);");
		expect(resolveReamBin(tmpRoot)).toBe(stub);
	});

	it("returns null when no binary is found", () => {
		expect(resolveReamBin(tmpRoot)).toBeNull();
	});

	it("honours REAM_BIN at <mkdtemp>/node_modules/.bin/ream where the .bin parent is 0755 but the tmpdir ancestor is 0700 (audit 2026-05-22 F4)", () => {
		// `mkdtempSync` produces a 0o700 root (`tmpRoot`); a normal
		// `mkdir -p node_modules/.bin` under it produces 0o755 dirs.
		// The previous immediate-parent owner-only check rejected the
		// override because `.bin` was 0o755 — the fallback `resolveReamBin`
		// path then rescued the lookup but the documented "REAM_BIN takes
		// precedence" contract was silently broken. Walking up the chain
		// finds the 0o700 ancestor (tmpRoot) before reaching the bare
		// tmpdir root and allows the override.
		const stub = writeStub("node_modules/.bin/ream", "process.exit(0);");
		process.env.REAM_BIN = stub;
		expect(resolveReamBin(tmpRoot)).toBe(stub);
	});
});

describeIfTmpExec("runReamCli", () => {
	it("rejects when REAM_MCP_NO_SHELL=1", async () => {
		process.env.REAM_MCP_NO_SHELL = "1";
		const stub = writeStub("ream", "process.exit(0);");
		process.env.REAM_BIN = stub;
		await expect(runReamCli(tmpRoot, ["info"])).rejects.toThrow(
			/REAM_MCP_NO_SHELL=1/,
		);
	});

	it("captures stdout/stderr and propagates exit code", async () => {
		// Use `process.exitCode` rather than `process.exit(N)` so Node
		// finishes draining stdout/stderr before terminating. Calling
		// `exit()` immediately after a buffered write races the pipe
		// flush and produces flaky empty captures on slower hosts.
		const stub = writeStub(
			"ream",
			"process.stdout.write('hello\\n');\n" +
				"process.stderr.write('warn\\n');\n" +
				"process.exitCode = 7;",
		);
		process.env.REAM_BIN = stub;
		const r = await runReamCli(tmpRoot, ["info"]);
		expect(r.exitCode).toBe(7);
		expect(r.stdout.trim()).toBe("hello");
		expect(r.stderr.trim()).toBe("warn");
		expect(r.truncated).toBe(false);
	});

	it("caps output at MAX_OUTPUT_BYTES and writes overflow file", async () => {
		const stub = writeStub(
			"ream",
			// 50 KB stdout — well above 32 KB cap. Use exitCode (not
			// exit()) to give Node time to flush the buffered write.
			"const big = 'x'.repeat(50000);\n" +
				"process.stdout.write(big);\n" +
				"process.exitCode = 0;",
		);
		process.env.REAM_BIN = stub;
		const r = await runReamCli(tmpRoot, ["info"]);
		expect(r.truncated).toBe(true);
		expect(r.fullOutputPath).toBeDefined();
		expect(r.stdout.length).toBeLessThanOrEqual(32_768);
	});

	it("kills the child on timeout", async () => {
		const stub = writeStub(
			"ream",
			"setTimeout(() => process.exit(0), 60_000);",
		);
		process.env.REAM_BIN = stub;
		const r = await runReamCli(tmpRoot, ["info"], { timeoutMs: 200 });
		expect(r.timeout).toBe(true);
	});

	it("spawns with no shell — args delivered as array (M8)", async () => {
		// ESM forbids spying on `node:child_process.spawn`; use a stub
		// that captures its argv to a marker file. If shell: true had
		// been used, the args would arrive concatenated as one shell
		// command; with array-args + shell: false they arrive as a
		// JS array exactly as we passed them.
		const markerPath = join(tmpRoot, "argv.json");
		const stub = writeStub(
			"ream",
			`require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(process.argv.slice(2))); process.exit(0);`,
		);
		process.env.REAM_BIN = stub;
		await runReamCli(tmpRoot, ["info", "--flag", "with space"]);
		const captured = JSON.parse(readFileSync(markerPath, "utf8")) as string[];
		// With shell: false + array-args, every token is its own argv
		// entry — including the one with a space. Shell expansion would
		// have split it on whitespace.
		expect(captured).toEqual(["info", "--flag", "with space"]);
	});

	it("rejects REAM_BIN pointing outside project root and tmpdir", () => {
		// /etc is outside both project root and tmpdir.
		process.env.REAM_BIN = "/etc/passwd";
		expect(resolveReamBin(tmpRoot)).toBeNull();
	});

	it("uses combined-stream byte cap (M4)", async () => {
		// 20 KB stdout + 20 KB stderr = 40 KB combined → exceeds 32 KB.
		const stub = writeStub(
			"ream",
			"const half = 'x'.repeat(20_000);\n" +
				"process.stdout.write(half);\n" +
				"process.stderr.write(half);\n" +
				"process.exitCode = 0;",
		);
		process.env.REAM_BIN = stub;
		const r = await runReamCli(tmpRoot, ["info"]);
		expect(r.truncated).toBe(true);
		// Combined retained bytes ≤ 32 KB cap.
		expect(r.stdout.length + r.stderr.length).toBeLessThanOrEqual(32_768);
	});
});

describe("sanitizeSpawnError (L6)", () => {
	it("strips POSIX absolute paths", () => {
		const cleaned = sanitizeSpawnError(
			"ENOENT: spawn /home/user/secret/.cargo/target/release/ream",
		);
		expect(cleaned).not.toContain("/home/user");
		expect(cleaned).toContain("<path>");
	});

	it("strips Windows absolute paths", () => {
		const cleaned = sanitizeSpawnError(
			"ENOENT: spawn C:\\Users\\Alice\\AppData\\ream.exe",
		);
		expect(cleaned).not.toContain("Alice");
		expect(cleaned).toContain("<path>");
	});
});
