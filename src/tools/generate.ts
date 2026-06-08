/**
 * `generate.*` MCP tools — Story 33.4.
 *
 * Six write-capable scaffolding tools that delegate to the local
 * `ream` Rust CLI binary. Default mode is `dryRun: true` — every call
 * returns `plannedFiles[]` for agent review; the caller must
 * explicitly set `confirm: true` (alias for `dryRun: false`) to
 * actually write files.
 *
 * Defense-in-depth on shell injection:
 *   1. Tool descriptor JSON Schema enforces `^[A-Z][A-Za-z0-9]*$`.
 *   2. This dispatcher re-validates every input with the same regex
 *      BEFORE spawning anything.
 *   3. `cli-runner.ts` passes args as a string array, never `shell:
 *      true`.
 *   4. The Rust `validate_class_name` runs server-side so even a
 *      compromised TS layer can't inject metacharacters.
 *
 * For class kinds (controller/entity/validator/seeder) the Rust layer
 * applies the strict PascalCase rule. For `provider`/`migration` the
 * Rust layer falls back to `validate_name_relaxed` (alphanumeric + `-`
 * + `_`, no leading `-`/`_`) — the descriptor still pins PascalCase
 * for the MCP path, so the LLM is held to the strict rule.
 */

import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
	type RunResult,
	runReamCli,
	sanitizeSpawnError,
} from "../util/cli-runner.js";
import {
	type DryRunPayload,
	isConflictPayload,
	isDryRunPayload,
	isWrittenPayload,
	makeOverflowSink,
	normalizePlannedFile,
	type PlannedFile,
	parseTrailingJson,
	type WrittenPayload,
} from "../util/dry-run.js";

export { GENERATE_TOOLS, isGenerateTool } from "./generate.descriptors.js";

const CLASS_NAME_RE = /^[A-Z][A-Za-z0-9]*$/;
const MODULE_RE = /^[a-z][a-z0-9-]*$/;

type Confidence = "high" | "medium" | "low";

interface Wrapped {
	confidence: Confidence;
	knownGaps: string[];
}

interface DryRunResponse extends Wrapped {
	plannedFiles: PlannedFile[];
	warnings: string[];
	truncated?: boolean;
	fullOutputPath?: string;
	plannedFilesOverflowPath?: string;
}

interface WriteResponse extends Wrapped {
	createdFiles: string[];
	modifiedFiles: string[];
	output: string;
	truncated?: boolean;
	fullOutputPath?: string;
}

interface ErrorResponse extends Wrapped {
	error: string;
	hint: string;
	conflicts?: string[];
}

export type GenerateResponse = DryRunResponse | WriteResponse | ErrorResponse;

interface GenerateArgs {
	module?: string;
	name?: string;
	dryRun?: boolean;
	confirm?: boolean;
	force?: boolean;
}

const KIND_BY_TOOL: Record<string, string> = {
	"generate.module": "module",
	"generate.controller": "controller",
	"generate.entity": "entity",
	"generate.migration": "migration",
	"generate.seeder": "seeder",
	"generate.validator": "validator",
};

const MODULE_REQUIRED: ReadonlySet<string> = new Set([
	"generate.module",
	"generate.controller",
	"generate.entity",
	"generate.validator",
]);

export async function dispatchGenerate(
	root: string,
	name: string,
	rawArgs: Record<string, unknown> = {},
): Promise<GenerateResponse> {
	const kind = KIND_BY_TOOL[name];
	if (!kind) {
		return shapeError(`Unknown generate tool: ${name}`, "");
	}

	const args = rawArgs as GenerateArgs;

	const validation = validateArgs(name, args);
	if (validation) return validation;

	// Resolve dryRun semantics — STRICT consent rule:
	//   - default → dryRun: true (preview only)
	//   - confirm: true → dryRun: false (write)
	//   - dryRun: false alone (no confirm) → REJECT — the alias
	//     contract requires the explicit consent token.
	//   - dryRun: true AND confirm: true → contradictory.
	if (args.dryRun === true && args.confirm === true) {
		return shapeError(
			"contradictory flags: dryRun=true AND confirm=true",
			"pick one — `dryRun: true` plans without writing, `confirm: true` writes.",
		);
	}
	if (args.dryRun === false && args.confirm !== true) {
		return shapeError(
			"missing consent: dryRun=false requires confirm=true",
			"set `confirm: true` to actually write the planned files.",
		);
	}
	const dryRun = !(args.confirm === true);
	const force = args.force === true;

	const className = args.name as string;
	const moduleName = (args.module as string | undefined) ?? "";

	if (!dryRun && !force) {
		const conflicts = preCheckConflicts(root, kind, moduleName, className);
		if (conflicts.length > 0) {
			return {
				error: "files already exist",
				hint: "set force: true to overwrite (and confirm: true to actually write)",
				conflicts,
				confidence: "low",
				knownGaps: [],
			};
		}
	}

	const cliArgs = buildCliArgs(kind, moduleName, className, dryRun, force);
	let result: RunResult;
	try {
		result = await runReamCli(root, cliArgs);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return shapeError("ream cli failed to spawn", sanitizeSpawnError(detail));
	}

	if (result.timeout) {
		return shapeError(
			"ream cli timeout",
			"the binary did not finish within the allowed window — see ream-mcp stderr for the SIGKILL line.",
		);
	}

	if (result.overflowExceeded) {
		return shapeError(
			"ream cli overflow exceeded — output dropped",
			"the binary streamed more than 1 MB after the 32 KB cap; SIGKILL fired. Investigate ream-cli.",
		);
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = parseTrailingJson(result.stdout);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return shapeError(
			`ream cli produced no JSON output (exit ${result.exitCode})`,
			sanitizeSpawnError(detail || result.stderr.slice(0, 400)),
		);
	}

	if (isConflictPayload(parsed)) {
		return {
			error: parsed.error,
			hint: parsed.hint,
			conflicts: parsed.conflicts,
			confidence: "low",
			knownGaps: [],
		};
	}

	// Non-zero exit code with valid (non-conflict) JSON is suspect —
	// the contract says exit 0 on success, exit 1 on conflict (which
	// we already routed). Anything else is a bug we shouldn't claim
	// success for.
	if (result.exitCode !== 0 && result.exitCode !== null) {
		return shapeError(
			`ream cli exited with code ${result.exitCode}`,
			sanitizeSpawnError(result.stderr.slice(0, 400)),
		);
	}

	if (dryRun) {
		if (!isDryRunPayload(parsed)) {
			return shapeError(
				"ream cli returned a malformed dry-run payload",
				JSON.stringify(parsed).slice(0, 400),
			);
		}
		return shapeDryRun(parsed, result);
	}

	if (!isWrittenPayload(parsed)) {
		return shapeError(
			`ream cli returned a malformed write payload (exit ${result.exitCode})`,
			JSON.stringify(parsed).slice(0, 400),
		);
	}
	return shapeWritten(parsed, result);
}

function validateArgs(tool: string, args: GenerateArgs): ErrorResponse | null {
	if (typeof args.name !== "string") {
		return shapeError(
			`missing required argument 'name' for ${tool}`,
			"pass `{ name: '<PascalCase>' }`.",
		);
	}
	if (!CLASS_NAME_RE.test(args.name)) {
		return shapeError(
			`invalid name '${args.name}'`,
			"name must match ^[A-Z][A-Za-z0-9]*$ (PascalCase, ASCII only).",
		);
	}
	if (MODULE_REQUIRED.has(tool)) {
		if (typeof args.module !== "string" || args.module.length === 0) {
			return shapeError(
				`missing required argument 'module' for ${tool}`,
				"pass `{ module: '<kebab-case>' }`.",
			);
		}
		if (!MODULE_RE.test(args.module)) {
			return shapeError(
				`invalid module '${args.module}'`,
				"module must match ^[a-z][a-z0-9-]*$ (kebab-case, ASCII only).",
			);
		}
	} else if (typeof args.module === "string" && args.module.length > 0) {
		if (!MODULE_RE.test(args.module)) {
			return shapeError(
				`invalid module '${args.module}'`,
				"module must match ^[a-z][a-z0-9-]*$ (kebab-case, ASCII only).",
			);
		}
	}
	for (const flag of ["dryRun", "confirm", "force"] as const) {
		const value = args[flag];
		if (value !== undefined && value !== true && value !== false) {
			return shapeError(`invalid ${flag}`, `${flag} must be a boolean.`);
		}
	}
	return null;
}

function buildCliArgs(
	kind: string,
	moduleName: string,
	className: string,
	dryRun: boolean,
	force: boolean,
): string[] {
	const flags: string[] = [];
	if (dryRun) flags.push("--dry-run");
	if (force) flags.push("--force");

	switch (kind) {
		case "module":
			return ["make:module", moduleName, className, ...flags];
		case "controller":
			return ["make:controller", moduleName, className, ...flags];
		case "entity":
			return ["make:entity", moduleName, className, ...flags];
		case "validator":
			return ["make:validator", moduleName, className, ...flags];
		case "seeder":
			// Module is OPTIONAL for seeders — when omitted, pass an
			// empty positional. The CLI accepts an empty module for
			// `seeder` (file lives under `database/seeders/`).
			return moduleName
				? ["make:seeder", moduleName, className, ...flags]
				: ["make:seeder", "", className, ...flags];
		case "migration":
			return ["make:migration", className, ...flags];
		default:
			throw new Error(`unreachable kind: ${kind}`);
	}
}

/**
 * Walk the would-be planned files BEFORE spawning the CLI. Uses
 * `lstatSync` (NOT `existsSync`) so a symlink in the planned location
 * is detected as a conflict regardless of where it points.
 */
function preCheckConflicts(
	root: string,
	kind: string,
	moduleName: string,
	className: string,
): string[] {
	const planned = predictPaths(kind, moduleName, className);
	const conflicts: string[] = [];
	for (const p of planned) {
		try {
			lstatSync(join(root, p));
			conflicts.push(p);
		} catch {
			// ENOENT — clean. Other errors (EACCES, etc.) we treat as
			// "can't determine", let the CLI handle it.
		}
	}
	return conflicts;
}

function predictPaths(
	kind: string,
	moduleName: string,
	className: string,
): string[] {
	const ensure = (n: string, suffix: string) =>
		n.endsWith(suffix) ? n : `${n}${suffix}`;
	switch (kind) {
		case "module":
			// 4 files; migration filename uses a runtime timestamp + random
			// suffix so we only check the deterministic three.
			return [
				`app/${moduleName}/${className}.ts`,
				`app/${moduleName}/${ensure(className, "Controller")}.ts`,
				`app/${moduleName}/${ensure(className, "Validator")}.ts`,
			];
		case "controller":
			return [`app/${moduleName}/${ensure(className, "Controller")}.ts`];
		case "entity":
			return [`app/${moduleName}/${className}.ts`];
		case "validator":
			return [`app/${moduleName}/${ensure(className, "Validator")}.ts`];
		case "seeder":
			return [`database/seeders/${ensure(className, "Seeder")}.ts`];
		case "migration":
			// timestamp-prefixed filename — can't predict at planning time.
			return [];
		default:
			return [];
	}
}

function shapeDryRun(
	payload: DryRunPayload,
	result: RunResult,
): DryRunResponse {
	const sink = makeOverflowSink();
	let anyContentTruncated = false;
	const plannedFiles: PlannedFile[] = payload.files.map((f) => {
		const { file, truncated } = normalizePlannedFile(f, sink.path);
		if (truncated) anyContentTruncated = true;
		return file;
	});
	// Force the sink to materialize lazily — `sink.path()` was only
	// called inside `normalizePlannedFile` when actually needed.
	const knownGaps = collectGaps(payload.warnings, result);
	if (anyContentTruncated) {
		knownGaps.push(
			"one or more planned files exceeded the 8 KB content cap — see plannedFilesOverflowPath",
		);
	}
	const overflowPath = anyContentTruncated ? sink.path() : undefined;
	return {
		plannedFiles,
		warnings: payload.warnings,
		confidence: knownGaps.length === 0 ? "high" : "medium",
		knownGaps,
		...(result.truncated || anyContentTruncated ? { truncated: true } : {}),
		...(result.fullOutputPath ? { fullOutputPath: result.fullOutputPath } : {}),
		...(overflowPath ? { plannedFilesOverflowPath: overflowPath } : {}),
	};
}

function shapeWritten(
	payload: WrittenPayload,
	result: RunResult,
): WriteResponse {
	const knownGaps = collectGaps(payload.warnings, result);
	const combined = `${result.stdout}\n${result.stderr}`.trim();
	const outputBytes = Buffer.from(combined, "utf8");
	const cappedOutput =
		outputBytes.length <= 32_768
			? combined
			: outputBytes.subarray(0, 32_768).toString("utf8");
	return {
		createdFiles: payload.createdFiles.map((p) => p.replace(/\\/g, "/")),
		modifiedFiles: payload.modifiedFiles.map((p) => p.replace(/\\/g, "/")),
		output: cappedOutput,
		confidence: knownGaps.length === 0 ? "high" : "medium",
		knownGaps,
		...(result.truncated ? { truncated: true } : {}),
		...(result.fullOutputPath ? { fullOutputPath: result.fullOutputPath } : {}),
	};
}

function collectGaps(warnings: string[], result: RunResult): string[] {
	const gaps: string[] = [...warnings];
	if (result.truncated) {
		gaps.push("output exceeded 32KB cap — see fullOutputPath for the rest");
	}
	return gaps;
}

function shapeError(error: string, hint: string): ErrorResponse {
	return { error, hint, confidence: "low", knownGaps: [] };
}
