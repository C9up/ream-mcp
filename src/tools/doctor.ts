/**
 * `doctor.*` MCP tools — Story 33.8.
 *
 * Read-only health-check tools. `doctor.health` shells out to
 * `cargo --version` (best-effort, 5s timeout, 32 KB cap), reads
 * `process.version` for Node, and walks workspace packages to
 * enumerate built / missing NAPI binaries. `doctor.env_check`
 * reports a fixed list of expected env vars (sensitive values
 * NEVER echoed) plus expected config files.
 *
 * No new heavy CJS imports — stays well under the cold-boot SLA.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { walkWorkspacePackages } from "../util/package-walker.js";

export {
	DOCTOR_TOOLS,
	isDoctorTool,
} from "./doctor.descriptors.js";

type Confidence = "high" | "medium" | "low";

const CARGO_TIMEOUT_MS = 5_000;
const STDOUT_CAP_BYTES = 32_768;

const REQUIRED_ENV_VARS: ReadonlyArray<{
	name: string;
	sensitive: boolean;
	hint: string;
}> = [
	{
		name: "NODE_ENV",
		sensitive: false,
		hint: "set to `development`, `production`, or `test`",
	},
	{
		name: "REAM_ENV",
		sensitive: false,
		hint: "explicit framework env override; takes priority over NODE_ENV",
	},
	{
		name: "DATABASE_URL",
		sensitive: true,
		hint: "12-factor database connection string",
	},
	{
		name: "REAM_DATABASE_URL",
		sensitive: true,
		hint: "framework-specific database URL; takes priority over DATABASE_URL",
	},
	{
		name: "REAM_BMAD_ROOT",
		sensitive: false,
		hint: "explicit BMAD root override; defaults to `<root>/_bmad-output/`",
	},
	{
		name: "REAM_MIGRATIONS_DIR",
		sensitive: false,
		hint: "migrations directory override; defaults to `<root>/database/migrations/`",
	},
];

const REQUIRED_CONFIG_FILES: ReadonlyArray<{
	path: string;
	hint: string;
}> = [
	{
		path: "package.json",
		hint: "required at the project root",
	},
	{
		path: "tsconfig.json",
		hint: "required for TypeScript projects; controls the compiler used by ts-morph",
	},
	{
		path: "reamrc.ts",
		hint: "framework config file; database / bmadRoot / migrations dir live here",
	},
	{
		path: "pnpm-workspace.yaml",
		hint: "optional; only required when the project uses a pnpm workspace",
	},
];

export async function dispatchDoctor(
	root: string,
	name: string,
	args: Record<string, unknown> = {},
): Promise<unknown> {
	void args;
	switch (name) {
		case "doctor.health":
			return runHealth(root);
		case "doctor.env_check":
			return runEnvCheck(root);
		default:
			return shapeError(`Unknown doctor tool: ${name}`, "");
	}
}

// ---------------------------------------------------------- envelopes

function shapeError(
	error: string,
	hint: string,
): {
	error: string;
	hint: string;
	confidence: Confidence;
	knownGaps: string[];
} {
	return { error, hint, confidence: "low", knownGaps: [] };
}

function wrap<T extends Record<string, unknown>>(
	body: T,
	knownGaps: string[],
): T & { confidence: Confidence; knownGaps: string[] } {
	return {
		...body,
		confidence: knownGaps.length === 0 ? "high" : "medium",
		knownGaps,
	};
}

// ----------------------------------------------------------- health

interface NapiBinary {
	package: string;
	binary: string;
}

interface MissingBinary {
	package: string;
	expected: string;
	hint: string;
}

async function runHealth(root: string): Promise<unknown> {
	const knownGaps: string[] = [];
	const nodeVersion = process.version;
	const rustVersion = await tryCargoVersion(knownGaps);

	const napiBinariesBuilt: NapiBinary[] = [];
	const missingBinaries: MissingBinary[] = [];
	const packages = walkWorkspacePackages(root);
	for (const pkg of packages) {
		const napi = readNapiField(pkg.dir);
		if (!napi) continue;
		const found = findNapiArtifact(pkg.dir, napi.name);
		if (found) {
			napiBinariesBuilt.push({
				package: pkg.name,
				binary: forwardSlash(relative(root, found)),
			});
		} else {
			const expected = forwardSlash(
				relative(root, join(pkg.dir, `${napi.name}.{platform}.node`)),
			);
			missingBinaries.push({
				package: pkg.name,
				expected,
				hint: `run \`pnpm --filter ${pkg.name} ${napi.script}\``,
			});
		}
	}

	const workspaceClean = checkWorkspaceClean(root, packages, knownGaps);

	napiBinariesBuilt.sort((a, b) => a.package.localeCompare(b.package));
	missingBinaries.sort((a, b) => a.package.localeCompare(b.package));

	return wrap(
		{
			nodeVersion,
			rustVersion,
			napiBinariesBuilt,
			missingBinaries,
			workspaceClean,
		},
		knownGaps,
	);
}

async function tryCargoVersion(knownGaps: string[]): Promise<string | null> {
	try {
		const out = await runCommand("cargo", ["--version"], CARGO_TIMEOUT_MS);
		if (out === null) {
			knownGaps.push(
				"cargo --version did not return within 5s; rust toolchain may be missing",
			);
			return null;
		}
		const trimmed = out.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		knownGaps.push(`cargo --version failed: ${detail}`);
		return null;
	}
}

function readNapiField(
	pkgDir: string,
): { name: string; script: string } | null {
	const path = join(pkgDir, "package.json");
	if (!existsSync(path)) return null;
	let raw: { name?: unknown; napi?: unknown; scripts?: unknown };
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as typeof raw;
	} catch {
		return null;
	}
	if (!raw.napi || typeof raw.napi !== "object") return null;
	const napi = raw.napi as { name?: unknown; binaryName?: unknown };
	const name =
		typeof napi.binaryName === "string"
			? napi.binaryName
			: typeof napi.name === "string"
				? napi.name
				: null;
	if (!name) return null;
	const scripts =
		raw.scripts && typeof raw.scripts === "object"
			? (raw.scripts as Record<string, unknown>)
			: {};
	const script =
		typeof scripts["build:napi"] === "string"
			? "build:napi"
			: typeof scripts.build === "string"
				? "build"
				: "build:napi";
	return { name, script };
}

// NAPI artifacts land at `<pkgDir>/<name>.<triple>.node`
// (e.g. `index.linux-x64-gnu.node`) or, in some prebuild layouts,
// `<pkgDir>/<name>.node`. Probe both.
function findNapiArtifact(pkgDir: string, name: string): string | null {
	const bare = join(pkgDir, `${name}.node`);
	if (existsSync(bare)) return bare;
	let entries: string[];
	try {
		entries = readdirSync(pkgDir);
	} catch {
		return null;
	}
	const prefix = `${name}.`;
	for (const entry of entries) {
		if (entry.startsWith(prefix) && entry.endsWith(".node")) {
			return join(pkgDir, entry);
		}
	}
	return null;
}

function checkWorkspaceClean(
	root: string,
	packages: ReturnType<typeof walkWorkspacePackages>,
	knownGaps: string[],
): boolean {
	const rootPkg = join(root, "package.json");
	if (!existsSync(rootPkg)) {
		knownGaps.push("workspace root package.json missing");
		return false;
	}
	let rootVersion: string | null = null;
	try {
		const raw = JSON.parse(readFileSync(rootPkg, "utf8")) as {
			version?: unknown;
			workspaces?: unknown;
		};
		if (typeof raw.version === "string") rootVersion = raw.version;
	} catch {
		knownGaps.push("workspace root package.json is unparseable");
		return false;
	}
	if (rootVersion === null) return true;
	let clean = true;
	for (const pkg of packages) {
		const path = join(pkg.dir, "package.json");
		try {
			const raw = JSON.parse(readFileSync(path, "utf8")) as {
				version?: unknown;
				private?: unknown;
			};
			if (raw.private === true) continue;
			if (typeof raw.version !== "string") continue;
			if (raw.version !== rootVersion) {
				knownGaps.push(
					`workspace drift: ${pkg.name} version ${raw.version} does not match root ${rootVersion}`,
				);
				clean = false;
			}
		} catch {
			// Ignore unparseable package.json — covered by the package
			// walker's own validation.
		}
	}
	return clean;
}

// --------------------------------------------------------- env_check

async function runEnvCheck(root: string): Promise<unknown> {
	const envVars = REQUIRED_ENV_VARS.map((entry) => ({
		name: entry.name,
		set:
			typeof process.env[entry.name] === "string" &&
			(process.env[entry.name] as string).length > 0,
		sensitive: entry.sensitive,
		hint: entry.hint,
	}));
	const configFiles = REQUIRED_CONFIG_FILES.map((entry) => ({
		path: entry.path,
		exists: existsSync(join(root, entry.path)),
		hint: entry.hint,
	}));
	return wrap({ envVars, configFiles }, []);
}

// ------------------------------------------------------------ shell

/**
 * Spawn `cmd args`, return concatenated stdout (capped at 32 KB).
 * Returns `null` on timeout. Throws on spawn errors so the caller
 * can record a structured `knownGap`.
 */
function runCommand(
	cmd: string,
	args: string[],
	timeoutMs: number,
): Promise<string | null> {
	return new Promise((resolve, reject) => {
		// `shell: true` on Windows lets PATH lookup pick up `.cmd`
		// shims (e.g., `cargo.cmd`); on POSIX it adds nothing useful.
		const child = spawn(cmd, args, {
			stdio: ["ignore", "pipe", "ignore"],
			shell: process.platform === "win32",
		});
		let buf = "";
		let truncated = false;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, timeoutMs);

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (truncated) return;
			if (buf.length + chunk.length > STDOUT_CAP_BYTES) {
				buf = `${buf}${chunk.slice(0, STDOUT_CAP_BYTES - buf.length)}`;
				truncated = true;
				return;
			}
			buf += chunk;
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (signal === "SIGKILL") {
				resolve(null);
				return;
			}
			if (code === 0) resolve(buf);
			else reject(new Error(`exit code ${code ?? "null"}, stderr suppressed`));
		});
	});
}

function forwardSlash(p: string): string {
	return p.replace(/\\/g, "/");
}
