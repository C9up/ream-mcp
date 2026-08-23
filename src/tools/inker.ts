/**
 * `inker.*` MCP tools.
 *
 * Two read-only / sandboxed tools that surface @c9up/inker state
 * without booting the host app:
 *
 *   - `inker.list_templates` — walks the templates root, optionally
 *     parsing each file to surface lex/parse errors per template.
 *   - `inker.render_test` — renders a single template through
 *     `Templates#render` with a caller-supplied data object. No
 *     canonical helpers are wired (`t` / `csrfField` / `url` /
 *     `asset` all throw via the default Templates ctor), so this
 *     fits templates that don't depend on the runtime context.
 *
 * Every handler returns a structured `{error, hint, …}` object on
 * misconfiguration rather than throwing.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { INKER_TOOLS, isInkerTool } from "./inker.descriptors.js";

export { INKER_TOOLS, isInkerTool };

const DEFAULT_TEMPLATES_ROOT = "resources/templates";

type Confidence = "high" | "medium" | "low";

interface ListTemplatesResult {
	root: string;
	templates: Array<{
		name: string;
		relPath: string;
		sizeBytes: number;
		error?: { code: string; message: string; line?: number; column?: number };
	}>;
	confidence: Confidence;
	knownGaps: string[];
}

interface RenderResult {
	html?: string;
	error?: { code: string; message: string; line?: number; column?: number };
	hint?: string;
}

interface ShapedError {
	error: string;
	hint: string;
}

function shapeError(error: string, hint: string): ShapedError {
	return { error, hint };
}

/**
 * Resolve the templates directory, and refuse to leave the project.
 *
 * `root` comes from the tool call, so it is caller-supplied. An absolute path
 * was taken as-is and a relative one could climb with `..`, which made this a
 * reader for any file on the machine — `/etc`, a home directory, an SSH key —
 * from a tool that is only supposed to look at a project's views.
 *
 * Returns null when the path escapes; the caller turns that into a shaped error.
 */
function resolveTemplatesRoot(
	projectRoot: string,
	overrideRel: string | undefined,
): string | null {
	const rel =
		typeof overrideRel === "string" && overrideRel.length > 0
			? overrideRel
			: DEFAULT_TEMPLATES_ROOT;
	const base = resolve(projectRoot);
	const abs = isAbsolute(rel) ? resolve(rel) : resolve(base, rel);
	// `relative` climbing out shows up as a leading `..`; an absolute result
	// means a different root entirely (another drive on Windows).
	const inside = relative(base, abs);
	if (inside.startsWith("..") || isAbsolute(inside)) return null;
	return abs;
}

function walkTemplates(root: string): string[] {
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (dir === undefined) break;
		let entries: ReadonlyArray<{ name: string; isDirectory: () => boolean }>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.name.endsWith(".inker")) {
				out.push(full);
			}
		}
	}
	out.sort();
	return out;
}

export async function dispatchInker(
	root: string,
	name: string,
	args: Record<string, unknown> = {},
): Promise<unknown> {
	switch (name) {
		case "inker.list_templates":
			return listTemplates(root, args);
		case "inker.render_test":
			return renderTest(root, args);
		default:
			return shapeError(
				`Unknown inker tool: ${name}`,
				"This dispatcher only handles `inker.list_templates` and `inker.render_test`.",
			);
	}
}

async function listTemplates(
	projectRoot: string,
	args: Record<string, unknown>,
): Promise<ListTemplatesResult | ShapedError> {
	const overrideRoot = typeof args.root === "string" ? args.root : undefined;
	const lint = args.lint === true;
	const templatesRoot = resolveTemplatesRoot(projectRoot, overrideRoot);
	if (templatesRoot === null) {
		return shapeError(
			`The \`root\` argument points outside the project.`,
			"Give a path inside the project — this tool only reads its views.",
		);
	}
	const rootError = validateTemplatesRoot(templatesRoot);
	if (rootError) return rootError;

	const files = walkTemplates(templatesRoot);
	const templates: ListTemplatesResult["templates"] = [];
	// Lazy-import the parser only when lint is requested — avoids loading
	// the @c9up/inker package machinery for a plain listing.
	let lex: ((src: string) => unknown) | undefined;
	let parse: ((tokens: unknown) => unknown) | undefined;
	let readFileSync: ((path: string, encoding: "utf8") => string) | undefined;
	if (lint) {
		const fsMod = await import("node:fs");
		readFileSync = fsMod.readFileSync;
		try {
			const inkerLex = await import("@c9up/inker/lex" as string).catch(
				() => null,
			);
			const inkerParse = await import("@c9up/inker/parse" as string).catch(
				() => null,
			);
			if (inkerLex !== null && inkerParse !== null) {
				lex = (inkerLex as { lex: typeof lex }).lex;
				parse = (inkerParse as { parse: typeof parse }).parse;
			}
		} catch {
			// Fall through — lint is best-effort. The listing still returns.
		}
	}
	for (const abs of files) {
		templates.push(
			buildTemplateEntry(abs, templatesRoot, lex, parse, readFileSync),
		);
	}
	return {
		root: relative(projectRoot, templatesRoot) || ".",
		templates,
		confidence: "high",
		knownGaps: [],
	};
}

/** Validate the templates root exists and is a directory, else a shaped error. */
function validateTemplatesRoot(templatesRoot: string): ShapedError | null {
	if (!existsSync(templatesRoot)) {
		return shapeError(
			`Templates root not found: ${templatesRoot}`,
			"Pass `root: '<relative-path>'` to point at a non-default location, or create `resources/templates` to use the convention.",
		);
	}
	if (!statSync(templatesRoot).isDirectory()) {
		return shapeError(
			`Templates root is not a directory: ${templatesRoot}`,
			"The `root` argument must resolve to a directory.",
		);
	}
	return null;
}

/**
 * Build one template listing entry. When the lint functions are present, parse
 * the file and attach any parse error; a stat failure mid-walk keeps size 0.
 */
function buildTemplateEntry(
	abs: string,
	templatesRoot: string,
	lex: ((src: string) => unknown) | undefined,
	parse: ((tokens: unknown) => unknown) | undefined,
	readFileSync: ((path: string, encoding: "utf8") => string) | undefined,
): ListTemplatesResult["templates"][number] {
	// Normalise to forward slashes so the MCP output is identical across OSes
	// (`relative()` yields backslashes on Windows).
	const relPath = relative(templatesRoot, abs).replace(/\\/g, "/");
	let sizeBytes = 0;
	try {
		sizeBytes = statSync(abs).size;
	} catch {
		// Stat failed mid-walk (file deleted between readdir and now);
		// keep size 0 and continue — the path stays in the listing.
	}
	const entry: ListTemplatesResult["templates"][number] = {
		name: relPath.replace(/\.inker$/, ""),
		relPath,
		sizeBytes,
	};
	if (lex !== undefined && parse !== undefined && readFileSync !== undefined) {
		try {
			parse(lex(readFileSync(abs, "utf8")));
		} catch (err) {
			entry.error = extractInkerError(err);
		}
	}
	return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Pull `{ code, message, line?, column? }` off a thrown inker parse error. */
function extractInkerError(err: unknown): {
	code: string;
	message: string;
	line?: number;
	column?: number;
} {
	const code =
		isRecord(err) && typeof err.code === "string"
			? err.code
			: "E_INKER_PARSE_ERROR";
	const message =
		isRecord(err) && typeof err.message === "string"
			? err.message
			: String(err);
	const context =
		isRecord(err) && isRecord(err.context) ? err.context : undefined;
	const line =
		context && typeof context.line === "number" ? context.line : undefined;
	const column =
		context && typeof context.column === "number" ? context.column : undefined;
	return { code, message, line, column };
}

/**
 * Strip absolute filesystem paths from an error string so a rendered
 * template error doesn't leak the project's directory layout through
 * the MCP wire (and from there into LLM context / chat history).
 * Mirrors `cli-runner.sanitizeSpawnError`.
 */
function sanitizePathsInMessage(detail: string): string {
	const winRe = /[A-Za-z]:\\[^\s'"`]+/g;
	const posixRe = /\/(?:[^\s/'"`]+\/)+[^\s/'"`]+/g;
	return detail.replace(winRe, "<path>").replace(posixRe, "<path>");
}

async function renderTest(
	projectRoot: string,
	args: Record<string, unknown>,
): Promise<RenderResult | ShapedError> {
	if (typeof args.template !== "string" || args.template.length === 0) {
		return shapeError(
			"missing required argument 'template'",
			"Pass `template: 'pages/welcome'` (relative to the templates root, no extension).",
		);
	}
	const templateName = args.template;
	const data =
		args.data && typeof args.data === "object" && !Array.isArray(args.data)
			? (args.data as Record<string, unknown>)
			: {};
	const overrideRoot = typeof args.root === "string" ? args.root : undefined;
	const templatesRoot = resolveTemplatesRoot(projectRoot, overrideRoot);
	if (templatesRoot === null) {
		return shapeError(
			"The `root` argument points outside the project.",
			"Give a path inside the project — this tool only reads its views.",
		);
	}
	if (!existsSync(templatesRoot)) {
		return shapeError(
			`Templates root not found: ${templatesRoot}`,
			"Pass `root: '<relative-path>'` to point at a non-default location.",
		);
	}
	let Templates: unknown;
	try {
		const mod = (await import("@c9up/inker" as string)) as {
			Templates: new (opts: {
				root: string;
			}) => {
				render(
					name: string,
					data: Readonly<Record<string, unknown>>,
				): Promise<string>;
			};
		};
		Templates = mod.Templates;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return shapeError(
			`Failed to load @c9up/inker: ${detail}`,
			"Run `pnpm install` (or `ream add @c9up/inker`) in the project before invoking this tool.",
		);
	}
	const Ctor = Templates as new (opts: {
		root: string;
	}) => {
		render(
			name: string,
			data: Readonly<Record<string, unknown>>,
		): Promise<string>;
	};
	const tpl = new Ctor({ root: templatesRoot });
	// Wall-clock deadline. The lex/parse/render pipeline has internal
	// recursion bounds (MAX_EXPRESSION_DEPTH=256, MAX_RENDER_DEPTH=100)
	// so a syntactically valid input can't blow the stack — but a
	// pathological template (e.g. `{% each items as item %}` against a
	// 10M-entry array) can still burn seconds of CPU and stall the MCP
	// transport. 5s is generous for any legitimate render, abrupt for
	// adversarial input. The Inker promise itself keeps running after
	// timeout (no in-language cancellation), but the response goes back
	// to the caller immediately.
	const RENDER_TIMEOUT_MS = 5_000;
	try {
		const html = await Promise.race([
			tpl.render(templateName, data),
			new Promise<never>((_, reject) => {
				const t = setTimeout(() => {
					reject(
						Object.assign(
							new Error(
								`inker.render_test exceeded ${RENDER_TIMEOUT_MS}ms — template is either pathologically deep or the data set is too large`,
							),
							{ code: "E_INKER_RENDER_TIMEOUT" },
						),
					);
				}, RENDER_TIMEOUT_MS);
				// Unref so the timer doesn't pin the Node event loop after
				// the response has gone back. The pending render task is
				// still keeping the loop alive on its own; we don't want
				// our deadline to ALSO keep it alive past resolution.
				if (typeof t === "object" && t !== null && "unref" in t) {
					(t as { unref: () => void }).unref();
				}
			}),
		]);
		return { html };
	} catch (err) {
		const e = err as {
			code?: string;
			message?: string;
			context?: { line?: number; column?: number };
		};
		const rawMessage = typeof e.message === "string" ? e.message : String(err);
		return {
			error: {
				code: typeof e.code === "string" ? e.code : "E_INKER_UNKNOWN",
				message: sanitizePathsInMessage(rawMessage),
				line: e.context?.line,
				column: e.context?.column,
			},
			hint: "Helpers `t`, `csrfField`, `url`, `asset` are NOT wired by this tool — templates that depend on them will throw. Use this tool for templates that take data only.",
		};
	}
}
