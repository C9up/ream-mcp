/**
 * Spawn helper for the local `ream` Rust CLI binary.
 *
 * Story 33.4: every `generate.*` MCP tool funnels through here.
 * Hard rules:
 *   - **Never** `shell: true`. Args go in as a string array. No
 *     concatenation. The binary itself re-validates names so even a
 *     compromised caller can't smuggle metacharacters.
 *   - Output is byte-capped at 32 KB **combined** (stdout + stderr).
 *     Once the cap is hit, further bytes go to a bounded overflow
 *     buffer (1 MB hard limit); past that we SIGKILL the child to
 *     prevent OOM. Truncated output spills to a temp file the LLM
 *     can fetch via `fullOutputPath`.
 *   - Hard timeout (default 30 s) — if the child doesn't finish, we
 *     SIGKILL and return `timeout: true`. No silent hangs.
 *   - Stderr-only logging. Stdout belongs to the JSON-RPC stream.
 *   - REAM_BIN must point to a path inside an allow-listed prefix
 *     (project root or system tmpdir). Arbitrary absolute paths are
 *     rejected to prevent lateral-movement via env injection.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
	dirname,
	join,
	sep as pathSep,
	resolve as resolvePath,
} from "node:path";

export const MAX_OUTPUT_BYTES = 32_768;
export const OVERFLOW_HARD_CAP_BYTES = 1_048_576; // 1 MB
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface RunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	fullOutputPath?: string;
	timeout: boolean;
	overflowExceeded: boolean;
}

export interface RunOptions {
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the `ream` binary on disk. Order of precedence:
 *   1. `REAM_BIN` env override — must resolve to a real file inside
 *      either `<root>` or `os.tmpdir()`. Anything else is REJECTED.
 *   2. `<root>/node_modules/.bin/ream` on POSIX ; on Windows the pnpm/npm
 *      shim writes `ream.cmd` (and a `.ps1` sibling), so we probe both
 *      extensions before giving up.
 *
 * Returns `null` when nothing matches — the caller is expected to
 * surface a structured error rather than blow up at spawn time.
 */
export function resolveReamBin(root: string): string | null {
	const fromEnv = process.env.REAM_BIN;
	if (fromEnv && isExecutableFile(fromEnv)) {
		if (isPathAllowed(fromEnv, root)) {
			return fromEnv;
		}
		process.stderr.write(
			`[ream-mcp] REAM_BIN points outside allowed prefixes (project root, tmpdir) — ignoring: ${fromEnv}\n`,
		);
	}
	const binDir = join(root, "node_modules", ".bin");
	const candidates =
		process.platform === "win32"
			? [
					join(binDir, "ream.cmd"),
					join(binDir, "ream.ps1"),
					join(binDir, "ream"),
				]
			: [join(binDir, "ream")];
	for (const candidate of candidates) {
		if (isExecutableFile(candidate)) {
			return candidate;
		}
	}
	return null;
}

function isExecutableFile(path: string): boolean {
	try {
		const st = statSync(path);
		return st.isFile();
	} catch {
		return false;
	}
}

/**
 * Allow REAM_BIN only if it resolves (after symlink resolution) inside
 * either the project root, or — strictly for tests that install a Node
 * stub via `mkdtempSync` — somewhere under a tmpdir ancestor that was
 * locked down to the current owner (mode `0o700`). The bare system tmpdir
 * itself (e.g. POSIX `/tmp` mode `1777`, world-writable + sticky) is
 * REJECTED because any local user could drop a binary there and trick a
 * privileged spawn via env injection.
 */
function isPathAllowed(candidate: string, root: string): boolean {
	let realCandidate: string;
	let realRoot: string;
	let realTmp: string;
	try {
		realCandidate = realpathSync(candidate);
		realRoot = realpathSync(resolvePath(root));
		realTmp = realpathSync(tmpdir());
	} catch {
		return false;
	}
	// Anchor on a separator so a sibling directory with a shared prefix
	// (`/var/myapp` vs `/var/myapp-evil`, or `/tmp` vs `/tmp-evil`) does
	// not slip past startsWith. Equality is allowed too — REAM_BIN
	// pointing at the directory itself is invalid here (statSync below
	// would reject a non-binary), but rejecting it lexically would
	// require the caller to also normalise trailing separators, so we
	// accept it and let the spawn fail.
	if (isWithin(realCandidate, realRoot)) return true;
	if (isWithin(realCandidate, realTmp)) {
		return hasOwnerOnlyAncestorBeforeTmp(realCandidate, realTmp);
	}
	return false;
}

/**
 * Audit 2026-05-22 F4: walk from the candidate's parent up the chain
 * until we hit the bare tmpdir, looking for an ancestor whose POSIX
 * mode has no group/other bits (`0o077 === 0`). The previous check
 * only inspected the immediate parent, which broke the common
 * `<mkdtemp>/node_modules/.bin/ream` layout: `mkdtemp` produces a
 * `0o700` root, but `.bin` (created by `mkdir -p`) inherits the
 * process umask (typically `0o755`). With the old logic the override
 * was silently rejected and only the fallback `<root>/node_modules/.bin`
 * scan rescued the lookup — the documented "REAM_BIN takes
 * precedence" contract was a lie for the typical tmpdir layout.
 *
 * On Windows the POSIX mode bits are largely synthetic (ACLs govern
 * actual access), so we defer to the existing tmpdir prefix check —
 * the Win32 per-user tmpdir model already restricts the shared-write
 * surface to the calling user's profile.
 */
function hasOwnerOnlyAncestorBeforeTmp(
	candidate: string,
	realTmp: string,
): boolean {
	if (process.platform === "win32") return true;
	let cur = dirname(candidate);
	while (cur !== realTmp && cur !== dirname(cur)) {
		try {
			const st = statSync(cur);
			if ((st.mode & 0o077) === 0) return true;
		} catch {
			return false;
		}
		cur = dirname(cur);
	}
	return false;
}

function isWithin(candidate: string, root: string): boolean {
	if (candidate === root) return true;
	const rootWithSep = root.endsWith(pathSep) ? root : root + pathSep;
	return candidate.startsWith(rootWithSep);
}

/**
 * Sandbox guard — when the env var is set we refuse to spawn at all.
 * Used by BMAD/CI environments where shell-out is disallowed.
 */
export function shellOutDisallowed(): boolean {
	return process.env.REAM_MCP_NO_SHELL === "1";
}

/**
 * Sanitize a spawn-error message for inclusion in MCP responses.
 * Strips absolute filesystem paths so an LLM client (or downstream
 * log) doesn't leak the user's directory layout.
 */
export function sanitizeSpawnError(detail: string): string {
	// Match `/abs/path` (POSIX) or `C:\abs\path` (Windows). Replace
	// with `<path>`. We strip both forms even on POSIX so test-runs
	// of cross-platform mocks don't leak.
	const winRe = /[A-Za-z]:\\[^\s'"]+/g;
	const posixRe = /\/(?:[^\s/'"]+\/)+[^\s'"]+/g;
	return detail.replace(winRe, "<path>").replace(posixRe, "<path>");
}

export async function runReamCli(
	root: string,
	args: string[],
	opts: RunOptions = {},
): Promise<RunResult> {
	if (shellOutDisallowed()) {
		throw new Error(
			"ream-mcp: REAM_MCP_NO_SHELL=1 — refusing to spawn the ream binary in this environment.",
		);
	}

	const bin = resolveReamBin(root);
	if (!bin) {
		throw new Error(
			"ream-mcp: cannot locate the `ream` binary. " +
				"Looked at $REAM_BIN (must be inside project root or tmpdir) " +
				"and <root>/node_modules/.bin/ream. " +
				"Run `pnpm install` in the project, or set REAM_BIN to a valid path.",
		);
	}

	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	process.stderr.write(
		`[ream-mcp] spawn ${bin} ${args.map((a) => JSON.stringify(a)).join(" ")}\n`,
	);

	return new Promise<RunResult>((resolve, reject) => {
		const child = spawn(bin, args, {
			cwd: root,
			env: opts.env ?? process.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		// Interleaved transcript — every chunk recorded in ARRIVAL order
		// with its stream tag. Used to rebuild a faithful spill file when
		// the output is truncated; reconstructing from the per-stream
		// arrays in sequence would interleave stdout/stderr in the wrong
		// order (all stdout, then all stderr) and discard the timeline an
		// operator needs to debug the truncated run.
		const interleaved: Array<{ stream: "stdout" | "stderr"; chunk: Buffer }> =
			[];
		let combinedBytes = 0;
		let overflowBytes = 0;
		let truncated = false;
		let overflowExceeded = false;

		const onChunk = (which: "stdout" | "stderr", chunk: Buffer): void => {
			const chunks = which === "stdout" ? stdoutChunks : stderrChunks;
			const remaining = MAX_OUTPUT_BYTES - combinedBytes;
			if (remaining > 0) {
				if (chunk.length <= remaining) {
					chunks.push(chunk);
					interleaved.push({ stream: which, chunk });
					combinedBytes += chunk.length;
				} else {
					const head = chunk.subarray(0, remaining);
					chunks.push(head);
					interleaved.push({ stream: which, chunk: head });
					combinedBytes += remaining;
					truncated = true;
					pushOverflow(which, chunk.subarray(remaining));
				}
			} else {
				truncated = true;
				pushOverflow(which, chunk);
			}
		};

		const pushOverflow = (which: "stdout" | "stderr", chunk: Buffer): void => {
			if (overflowBytes + chunk.length > OVERFLOW_HARD_CAP_BYTES) {
				if (!overflowExceeded) {
					overflowExceeded = true;
					process.stderr.write(
						`[ream-mcp] overflow exceeded ${OVERFLOW_HARD_CAP_BYTES}B — SIGKILL\n`,
					);
					child.kill("SIGKILL");
				}
				return;
			}
			interleaved.push({ stream: which, chunk });
			overflowBytes += chunk.length;
		};

		child.stdout.on("data", (c: Buffer) => onChunk("stdout", c));
		child.stderr.on("data", (c: Buffer) => onChunk("stderr", c));

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			process.stderr.write(
				`[ream-mcp] cli timeout after ${timeoutMs}ms — SIGKILL\n`,
			);
			child.kill("SIGKILL");
		}, timeoutMs);
		timer.unref();

		let settled = false;
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});

		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			let fullOutputPath: string | undefined;
			if (truncated && interleaved.length > 0) {
				try {
					const dir = mkdtempSync(join(tmpdir(), "ream-mcp-cli-"));
					fullOutputPath = join(dir, "output.log");
					// Tag each chunk with `[stdout]`/`[stderr]` on a separate
					// preamble line so the spill keeps both temporal order AND
					// stream attribution — the spill is exactly what an
					// operator reads when output was truncated, so guessing
					// the order would be worse than no spill at all.
					const parts: Buffer[] = [];
					let prevStream: "stdout" | "stderr" | null = null;
					for (const entry of interleaved) {
						if (entry.stream !== prevStream) {
							parts.push(Buffer.from(`\n[${entry.stream}]\n`, "utf8"));
							prevStream = entry.stream;
						}
						parts.push(entry.chunk);
					}
					writeFileSync(fullOutputPath, Buffer.concat(parts));
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					process.stderr.write(
						`[ream-mcp] failed to spill overflow output: ${detail}\n`,
					);
				}
			}
			resolve({
				exitCode: code,
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
				truncated,
				fullOutputPath,
				timeout: timedOut,
				overflowExceeded,
			});
		});
	});
}
