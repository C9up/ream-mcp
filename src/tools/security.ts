/**
 * `security.scan` MCP tool.
 *
 * Targeted static-security scanner for Ream-specific anti-
 * patterns. Read-only, deterministic. Drives a single ts-morph
 * `Project` per dispatch and fans every eligible source file
 * across the six check visitors.
 *
 * Heavy CJS imports (ts-morph) are dynamic-imported by the
 * server's `loadHandlers` Promise.all so the cold-boot path
 * stays under 250 ms.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { Project } from "ts-morph";
import { readProjectFacts } from "../security/checks/_project.js";
import type {
	CheckContext,
	CheckDefinition,
	RawFinding,
	Severity,
} from "../security/checks/_types.js";
import { SEVERITY_RANK } from "../security/checks/_types.js";
import { cookieMissingFlags } from "../security/checks/cookie_missing_flags.js";
import { csrfDisabled } from "../security/checks/csrf_disabled.js";
import { missingGuardOnMutationRoute } from "../security/checks/missing_guard_on_mutation_route.js";
import { rawErrorNotReamerror } from "../security/checks/raw_error_not_reamerror.js";
import { sqlInterpolation } from "../security/checks/sql_interpolation.js";
import { xssHtmlRawOutput } from "../security/checks/xss_html_raw_output.js";
import { walkProjectFiles } from "../util/fs-walk.js";
import {
	SECURITY_CHECK_IDS,
	type SecurityCheckId,
} from "./security.descriptors.js";

export {
	isSecurityTool,
	SECURITY_TOOLS,
} from "./security.descriptors.js";

type Confidence = "high" | "medium" | "low";

const FILE_CAP = 5000;
/** At most this many skipped directories are listed in the answer. */
const SKIPPED_LIST_CAP = 100;
/**
 * Directories skipped at the top level of the application and of each
 * package inside it (a directory holding a `package.json`): build output,
 * dependencies, test suites and their fixtures, which hold anti-patterns on
 * purpose. Deeper down, a directory of the same name is the application's
 * own code (`app/modules/build/`) and is read.
 */
const PACKAGE_LEVEL_SKIPS = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"target",
	"tmp",
	"tests",
	"test",
	"__tests__",
	"spec",
	"e2e",
	"fixtures",
]);
const TEST_FILE_RE = /\.(?:test|spec|fixture)\.tsx?$/;
const TS_FILE_RE = /\.(?:ts|tsx)$/;

const CHECKS: CheckDefinition[] = [
	sqlInterpolation,
	csrfDisabled,
	xssHtmlRawOutput,
	cookieMissingFlags,
	missingGuardOnMutationRoute,
	rawErrorNotReamerror,
];
const CHECK_BY_ID = new Map<SecurityCheckId, CheckDefinition>(
	CHECKS.map((c) => [c.id, c]),
);

interface Finding {
	id: string;
	severity: Severity;
	check: SecurityCheckId;
	file: string;
	line: number;
	excerpt: string;
	hint: string;
	docsUrl: string;
}

export async function dispatchSecurity(
	root: string,
	name: string,
	args: Record<string, unknown> = {},
): Promise<unknown> {
	if (name !== "security.scan") {
		return shapeError(`Unknown security tool: ${name}`, "");
	}
	return runScan(root, args);
}

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

/** What a scan read, so its reader can tell a clean scan from an empty one. */
interface Scanned {
	/** TypeScript files parsed. */
	files: number;
	/** `.inker` templates read. */
	templates: number;
	/** The top-level directories the files came from (`.` for the root itself). */
	directories: string[];
	/** Directories left unread, relative to the root (the first 100). */
	skipped: string[];
}

/**
 * `high` only for a scan that read something and has nothing to report as
 * undecided: a scan of zero files is never `high`.
 */
function wrap(
	findings: Finding[],
	scanned: Scanned,
	knownGaps: string[],
): {
	findings: Finding[];
	scanned: Scanned;
	confidence: Confidence;
	knownGaps: string[];
} {
	const read = scanned.files + scanned.templates;
	return {
		findings,
		scanned,
		confidence: knownGaps.length === 0 && read > 0 ? "high" : "medium",
		knownGaps,
	};
}

async function runScan(
	root: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const selection = parseChecks(args);
	if ("error" in selection) return shapeError(selection.error, selection.hint);

	const knownGaps: string[] = [];
	const walk = collectFiles(root, knownGaps);
	const files = walk.files;
	const facts = readProjectFacts(root);
	const findings: Finding[] = [];
	const scanned: Scanned = {
		files: 0,
		templates: 0,
		directories: topLevelDirectories(root, files),
		skipped: walk.skipped,
	};
	if (files.length === 0) knownGaps.push("no source files found");

	const project = new Project({
		skipFileDependencyResolution: true,
		skipAddingFilesFromTsConfig: true,
		useInMemoryFileSystem: false,
	});

	const selected = selection.checks.flatMap((id) => {
		const def = CHECK_BY_ID.get(id);
		return def ? [def] : [];
	});
	const relevant = new Map<SecurityCheckId, number>();
	for (const file of files) {
		let sf: import("ts-morph").SourceFile | null = null;
		try {
			sf = project.addSourceFileAtPath(file);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			knownGaps.push(`failed to parse ${toRel(root, file)}: ${detail}`);
			continue;
		}
		if (!sf) continue;
		scanned.files++;
		const ctx: CheckContext = {
			sf,
			relPath: toRel(root, file),
			project,
			root,
			knownGaps,
			facts,
		};
		for (const def of selected) {
			if (def.appliesTo?.(sf, ctx.relPath)) {
				relevant.set(def.id, (relevant.get(def.id) ?? 0) + 1);
			}
			let raw: RawFinding[];
			try {
				raw = def.run(ctx);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				knownGaps.push(
					`check ${def.id} threw on ${toRel(root, file)}: ${detail}`,
				);
				continue;
			}
			for (const r of raw) {
				findings.push(hydrate(def, ctx.relPath, r));
			}
		}
		// Drop the source file from the project to keep memory bounded
		// — the AST for a 5000-file scan would otherwise stay resident.
		project.removeSourceFile(sf);
	}

	for (const def of selected) {
		if (!def.appliesTo || (relevant.get(def.id) ?? 0) > 0) continue;
		const gap = def.nothingRead?.(facts) ?? null;
		if (gap !== null) knownGaps.push(gap);
	}

	if (selection.checks.includes("xss_html_raw_output")) {
		scanned.templates = scanInkerTemplates(root, findings, knownGaps);
	}

	findings.sort(compareFindings);
	return wrap(findings, scanned, knownGaps);
}

/** The first path segment of each file, `.` for a file at the root. */
function topLevelDirectories(root: string, files: readonly string[]): string[] {
	const dirs = new Set<string>();
	for (const file of files) {
		const rel = toRel(root, file);
		const slash = rel.indexOf("/");
		dirs.add(slash === -1 ? "." : rel.slice(0, slash));
	}
	return [...dirs].sort(compareAscii);
}

function compareAscii(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Best-effort scan for inker's raw output `{{{ expr }}}` inside templates.
 * Walks `<root>/resources/templates/**\/*.inker` (InkerProvider's default
 * directory) and pushes one finding per line that prints raw. Skipped: a
 * brace escaped as `\{{{` (printed literally) and template comments
 * `{{-- … --}}`, which inker strips without parsing. Full AST parsing is
 * parked behind the `knownGaps` entry this adds.
 */
function scanInkerTemplates(
	root: string,
	findings: Finding[],
	knownGaps: string[],
): number {
	const templatesDir = join(root, "resources", "templates");
	if (!existsSync(templatesDir)) return 0;
	knownGaps.push(
		"template XSS scan is regex-based; an AST-based scanner would cover more",
	);
	const inkerFiles = walkProjectFiles([templatesDir], {
		projectRoot: root,
		accept: (name) => name.endsWith(".inker"),
		maxFiles: FILE_CAP,
	}).files;
	const def = CHECK_BY_ID.get("xss_html_raw_output");
	if (!def) return 0;
	let read = 0;
	for (const file of inkerFiles) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			knownGaps.push(`failed to read ${toRel(root, file)}: ${detail}`);
			continue;
		}
		read++;
		const lines = text.split("\n");
		for (const line of rawOutputLines(text)) {
			const trimmed = (lines[line - 1] ?? "")
				.replace(/\r$/, "")
				.trim()
				.replace(/\t/g, "    ");
			const elided =
				trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
			findings.push(
				hydrate(def, toRel(root, file), {
					check: "xss_html_raw_output",
					line,
					excerpt: elided,
				}),
			);
		}
	}
	return read;
}

/** The 1-based lines of an inker template that open a raw `{{{` output. */
export function rawOutputLines(text: string): number[] {
	// Blank out comments, keeping their newlines so line numbers hold.
	const visible = text.replace(/\{\{--[\s\S]*?--\}\}/g, (comment) =>
		comment.replace(/[^\n]/g, " "),
	);
	const lines: number[] = [];
	for (const [i, raw] of visible.split("\n").entries()) {
		if (/(^|[^\\])\{\{\{/.test(raw)) lines.push(i + 1);
	}
	return lines;
}

interface SelectionOk {
	checks: SecurityCheckId[];
}

interface SelectionError {
	error: string;
	hint: string;
}

function parseChecks(
	args: Record<string, unknown>,
): SelectionOk | SelectionError {
	const raw = args.checks;
	if (raw === undefined) return { checks: [...SECURITY_CHECK_IDS] };
	if (!Array.isArray(raw)) {
		return {
			error: "invalid checks",
			hint: "checks must be an array of strings",
		};
	}
	if (raw.length === 0) return { checks: [...SECURITY_CHECK_IDS] };
	const seen = new Set<SecurityCheckId>();
	for (const item of raw) {
		const id = SECURITY_CHECK_IDS.find((known) => known === item);
		if (id === undefined) {
			const display = typeof item === "string" ? item : JSON.stringify(item);
			return {
				error: `unknown check: ${display}`,
				hint: `valid checks: ${[...SECURITY_CHECK_IDS].join(", ")}`,
			};
		}
		seen.add(id);
	}
	return { checks: [...seen] };
}

interface Collected {
	files: string[];
	/** Skipped directories, relative to the root, sorted, capped. */
	skipped: string[];
}

/**
 * Every TypeScript file of the application: the whole root, so `app/`,
 * `start/`, `config/`, `providers/`, `commands/`, `bin/`, a `src/` and the
 * packages it holds are all read, whatever else sits next to them.
 * {@link PACKAGE_LEVEL_SKIPS} applies at the top of the root and of each
 * package; dot directories and `node_modules` are skipped at any depth. A
 * directory skipped below a package's top level is application code left
 * unread, and goes to `knownGaps`.
 */
function collectFiles(root: string, knownGaps: string[]): Collected {
	const packageRoots = new Map<string, boolean>();
	const isPackageRoot = (dir: string): boolean => {
		let known = packageRoots.get(dir);
		if (known === undefined) {
			known = dir === root || existsSync(join(dir, "package.json"));
			packageRoots.set(dir, known);
		}
		return known;
	};
	const skipped: string[] = [];
	const walked = walkProjectFiles([root], {
		projectRoot: root,
		skipDir: (name, parent) =>
			name === "node_modules" ||
			(PACKAGE_LEVEL_SKIPS.has(name) && isPackageRoot(parent)),
		onSkipDir: (path) => {
			const rel = toRel(root, path);
			skipped.push(rel);
			if (!isPackageRoot(dirname(path))) {
				knownGaps.push(`directory not scanned: ${rel}`);
			}
		},
		accept: (name) =>
			TS_FILE_RE.test(name) &&
			!name.endsWith(".d.ts") &&
			!TEST_FILE_RE.test(name),
		maxFiles: FILE_CAP,
	});
	if (walked.capped) {
		knownGaps.push(
			`file walk capped at ${FILE_CAP} files; the files after it were not scanned`,
		);
	}
	skipped.sort(compareAscii);
	const listed = skipped.slice(0, SKIPPED_LIST_CAP);
	if (skipped.length > listed.length) {
		listed.push(`… ${skipped.length - listed.length} more`);
	}
	return { files: walked.files, skipped: listed };
}

function toRel(root: string, abs: string): string {
	return relative(root, abs).replace(/\\/g, "/");
}

function hydrate(
	def: CheckDefinition,
	relPath: string,
	raw: RawFinding,
): Finding {
	const id = createHash("sha1")
		.update(`${raw.check}:${relPath}:${raw.line}:${raw.excerpt}`)
		.digest("hex")
		.slice(0, 16);
	return {
		id,
		severity: def.severity,
		check: raw.check,
		file: relPath,
		line: raw.line,
		excerpt: raw.excerpt,
		hint: def.hint,
		docsUrl: def.docsUrl,
	};
}

function compareFindings(a: Finding, b: Finding): number {
	const sa = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
	if (sa !== 0) return sa;
	// Strict ASCII comparison — `localeCompare` varies by host
	// locale (Turkish dotted-i etc.) and would break the
	// determinism guarantee.
	if (a.file < b.file) return -1;
	if (a.file > b.file) return 1;
	return a.line - b.line;
}
