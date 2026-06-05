/**
 * `security.scan` MCP tool — Story 33.7.
 *
 * Targeted static-security scanner for Ream-specific anti-
 * patterns. Read-only, deterministic. Drives a single ts-morph
 * `Project` per dispatch and fans every eligible source file
 * across the seven check visitors.
 *
 * Heavy CJS imports (ts-morph) are dynamic-imported by the
 * server's `loadHandlers` Promise.all so the cold-boot path
 * stays under 250 ms.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { join, relative } from "node:path";

import { Project } from "ts-morph";
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
import {
	reflectMetadataMissing,
	resolveEntryFile,
} from "../security/checks/reflect_metadata_missing.js";
import { sqlInterpolation } from "../security/checks/sql_interpolation.js";
import { xssHtmlRawOutput } from "../security/checks/xss_html_raw_output.js";
import { walkWorkspacePackages } from "../util/package-walker.js";
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
const SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	".next",
	".cache",
	"coverage",
	".git",
	".turbo",
	".svelte-kit",
	"target",
	"out",
	"__tests__",
	// Test fixtures intentionally contain anti-patterns (the
	// `security-dirty/` fixture in this very repo would otherwise
	// flood the dispatch with seeded findings). Spec scope cut.
	"tests",
	"test",
	"e2e",
	"spec",
	"fixtures",
]);
const TEST_FILE_RE = /\.(?:test|spec|fixture)\.tsx?$/;
const TS_FILE_RE = /\.(?:ts|tsx)$/;

const CHECKS: CheckDefinition[] = [
	sqlInterpolation,
	csrfDisabled,
	xssHtmlRawOutput,
	cookieMissingFlags,
	reflectMetadataMissing,
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

async function runScan(
	root: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const selection = parseChecks(args);
	if ("error" in selection) return shapeError(selection.error, selection.hint);

	const knownGaps: string[] = [];
	const files = collectFiles(root, knownGaps);
	if (files.length === 0) {
		return wrap({ findings: [] as Finding[] }, [
			"no source files found",
			...knownGaps,
		]);
	}

	const entryFile = resolveEntryFile((rel) => existsSync(join(root, rel)));

	const project = new Project({
		skipFileDependencyResolution: true,
		skipAddingFilesFromTsConfig: true,
		useInMemoryFileSystem: false,
	});

	const findings: Finding[] = [];
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
		const ctx: CheckContext = {
			sf,
			relPath: toRel(root, file),
			project,
			root,
			entryFile,
		};
		for (const checkId of selection.checks) {
			const def = CHECK_BY_ID.get(checkId);
			if (!def) continue;
			let raw: RawFinding[];
			try {
				raw = def.run(ctx);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				knownGaps.push(
					`check ${checkId} threw on ${toRel(root, file)}: ${detail}`,
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

	if (selection.checks.includes("xss_html_raw_output")) {
		scanEdgeTemplates(root, findings, knownGaps);
	}

	findings.sort(compareFindings);
	return wrap({ findings }, knownGaps);
}

/**
 * Best-effort regex scan for raw-output `{{{ }}}` interpolations
 * inside Edge templates. Walks `<root>/views/**\/*.edge` (the
 * documented Ream Edge layout) and pushes one finding per
 * matching line. Full Edge AST parsing is parked behind the
 * `edge-AST scanner` knownGap.
 */
function scanEdgeTemplates(
	root: string,
	findings: Finding[],
	knownGaps: string[],
): void {
	const viewsDir = join(root, "views");
	if (!existsSync(viewsDir)) return;
	knownGaps.push(
		"edge XSS scan is regex-based; install the edge-AST scanner for full coverage",
	);
	const edgeFiles: string[] = [];
	walkEdgeFiles(viewsDir, edgeFiles);
	const def = CHECK_BY_ID.get("xss_html_raw_output");
	if (!def) return;
	for (const file of edgeFiles) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			knownGaps.push(`failed to read ${toRel(root, file)}: ${detail}`);
			continue;
		}
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i];
			if (!raw.includes("{{{")) continue;
			const trimmed = raw.replace(/\t/g, "    ").trim().replace(/\r$/, "");
			const elided =
				trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
			findings.push(
				hydrate(def, toRel(root, file), {
					check: "xss_html_raw_output",
					line: i + 1,
					excerpt: elided,
				}),
			);
		}
	}
}

function walkEdgeFiles(dir: string, out: string[]): void {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			walkEdgeFiles(full, out);
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".edge")) {
			out.push(full);
		}
	}
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
	const valid = new Set<string>(SECURITY_CHECK_IDS);
	const seen = new Set<SecurityCheckId>();
	for (const item of raw) {
		if (typeof item !== "string" || !valid.has(item)) {
			const display = typeof item === "string" ? item : JSON.stringify(item);
			return {
				error: `unknown check: ${display}`,
				hint: `valid checks: ${[...SECURITY_CHECK_IDS].join(", ")}`,
			};
		}
		seen.add(item as SecurityCheckId);
	}
	return { checks: [...seen] };
}

function collectFiles(root: string, knownGaps: string[]): string[] {
	const collected: string[] = [];
	const seen = new Set<string>();
	let capped = false;

	const pushFile = (abs: string): void => {
		if (capped) return;
		if (seen.has(abs)) return;
		if (collected.length >= FILE_CAP) {
			capped = true;
			knownGaps.push(
				`file walk capped at ${FILE_CAP} files; refine workspace layout to scan everything`,
			);
			return;
		}
		seen.add(abs);
		collected.push(abs);
	};

	const visited = new Set<string>();
	const packages = walkWorkspacePackages(root);
	if (packages.length > 0) {
		for (const pkg of packages) {
			const srcDir = existsSync(join(pkg.dir, "src"))
				? join(pkg.dir, "src")
				: pkg.dir;
			walkDir(srcDir, pushFile, visited);
			if (capped) break;
		}
	} else {
		const fallback = join(root, "src");
		if (existsSync(fallback)) walkDir(fallback, pushFile, visited);
	}

	return collected;
}

function walkDir(
	dir: string,
	push: (abs: string) => void,
	visited: Set<string>,
): void {
	// Track realpath to break symlink loops — pnpm-style symlinks
	// or hand-rolled `a -> ../a` cycles otherwise infinite-recurse.
	let real: string;
	try {
		real = realpathSync(dir);
	} catch {
		return;
	}
	if (visited.has(real)) return;
	visited.add(real);

	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walkDir(full, push, visited);
			continue;
		}
		if (!entry.isFile()) {
			// Symlink or other — best-effort statSync.
			try {
				const s = statSync(full);
				if (s.isDirectory()) {
					if (SKIP_DIRS.has(entry.name)) continue;
					walkDir(full, push, visited);
					continue;
				}
				if (!s.isFile()) continue;
			} catch {
				continue;
			}
		}
		if (entry.name.endsWith(".d.ts")) continue;
		if (!TS_FILE_RE.test(entry.name)) continue;
		if (TEST_FILE_RE.test(entry.name)) continue;
		push(full);
	}
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
