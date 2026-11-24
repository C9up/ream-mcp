/**
 * `inker.*` MCP tools.
 *
 * Two tools that surface @c9up/inker state without booting the host app.
 * Neither is read-only: the lint and the render import the PROJECT's
 * `@c9up/inker` into this process and run it (and a render runs the
 * template's expressions), so both are annotated as running project code.
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

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	existsInside,
	isInside,
	realpathOfNearest,
	safeRealpath,
} from "../util/containment.js";
import { walkProjectFiles } from "../util/fs-walk.js";
import { isRecord } from "../util/guards.js";
import { resolveProjectPackage } from "../util/project-package.js";
import { redactPaths } from "../util/redact.js";
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
	// The lexical check above is defeated by a symlink inside the project
	// (`resources/templates -> /`), so an existing root must also stay inside
	// once resolved.
	if (existsSync(abs) && !existsInside(abs, base)) return null;
	return abs;
}

const TEMPLATE_CAP = 5000;

function walkTemplates(
	projectRoot: string,
	templatesRoot: string,
): { files: string[]; capped: boolean } {
	const walked = walkProjectFiles([templatesRoot], {
		projectRoot,
		skipDotEntries: false,
		accept: (name) => name.endsWith(".inker"),
		maxFiles: TEMPLATE_CAP,
	});
	return { files: [...walked.files].sort(), capped: walked.capped };
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
	const rootError = validateTemplatesRoot(projectRoot, templatesRoot);
	if (rootError) return rootError;

	const walked = walkTemplates(projectRoot, templatesRoot);
	const files = walked.files;
	const templates: ListTemplatesResult["templates"] = [];
	const knownGaps: string[] = [];
	if (walked.capped) {
		knownGaps.push(`template listing capped at ${TEMPLATE_CAP} files`);
	}
	// Loaded only when lint is requested, and only from the INSPECTED project:
	// its inker is the one whose grammar its templates were written against.
	let compile: ((source: string, name?: string) => void) | undefined;
	if (lint) {
		const loaded = await loadProjectInker(projectRoot, templatesRoot);
		if ("failure" in loaded) {
			knownGaps.push(
				`lint requested but @c9up/inker could not be loaded from the project (${loaded.failure}) — templates are listed without a syntax check.`,
			);
		} else {
			compile = loaded.compile;
		}
	}
	for (const abs of files) {
		templates.push(buildTemplateEntry(abs, templatesRoot, compile));
	}
	return {
		root: relative(projectRoot, templatesRoot) || ".",
		templates,
		confidence: "high",
		knownGaps,
	};
}

/**
 * The bits of the project's `Templates` this server uses. Both are optional:
 * an older inker has `render` but not `compileRaw`, and each caller checks the
 * one it needs.
 */
interface ProjectEngine {
	compileRaw?: (source: string, name?: string) => void;
	render?: (
		name: string,
		data: Readonly<Record<string, unknown>>,
	) => string | Promise<string>;
}

function isProjectEngine(value: unknown): value is ProjectEngine {
	return isRecord(value);
}

type Loaded<T> = T | { failure: string };

/**
 * A `compileRaw`-shaped syntax checker from the INSPECTED project's inker.
 *
 * Resolved against the project rather than this package: ream-mcp does not
 * depend on inker, and checking a template against a different version's
 * grammar than the app renders it with would report errors the app does not
 * have. A failure says why (not installed, no import entry, the import
 * threw) — the caller puts it in `knownGaps` instead of reporting a clean
 * bill of health it never checked.
 */
async function loadProjectInker(
	projectRoot: string,
	templatesRoot: string,
): Promise<Loaded<{ compile: (source: string, name?: string) => void }>> {
	const engine = await loadProjectEngine(projectRoot, templatesRoot);
	if ("failure" in engine) return engine;
	if (typeof engine.compileRaw !== "function") {
		return { failure: "its Templates has no compileRaw (an older inker)" };
	}
	const compileRaw = engine.compileRaw.bind(engine);
	return {
		compile: (source, name) => {
			compileRaw(source, name);
		},
	};
}

/** The renderer half of the same engine — what `inker.render_test` drives. */
async function loadProjectRenderer(
	projectRoot: string,
	templatesRoot: string,
): Promise<
	Loaded<{
		render(
			name: string,
			data: Readonly<Record<string, unknown>>,
		): Promise<string>;
	}>
> {
	const engine = await loadProjectEngine(projectRoot, templatesRoot);
	if ("failure" in engine) return engine;
	if (typeof engine.render !== "function") {
		return { failure: "its Templates has no render" };
	}
	const render = engine.render.bind(engine);
	return {
		render: (name, data) => Promise.resolve(render(name, data)),
	};
}

/**
 * A `Templates` instance from the INSPECTED project, rooted at its templates
 * directory. The package is found under the `import` condition, as the
 * application itself imports it (`../util/project-package.ts`); importing it
 * runs its code in this process, which is why neither inker tool is
 * annotated read-only.
 */
async function loadProjectEngine(
	projectRoot: string,
	templatesRoot: string,
): Promise<Loaded<ProjectEngine>> {
	const entry = resolveProjectPackage(projectRoot, "@c9up/inker");
	if (entry.kind === "missing") {
		return { failure: "it is not installed in node_modules" };
	}
	if (entry.kind === "unresolvable") {
		return { failure: `it is installed but ${entry.reason}` };
	}
	let mod: unknown;
	try {
		mod = await import(pathToFileURL(entry.path).href);
	} catch (err) {
		const code = isRecord(err) && typeof err.code === "string" ? err.code : "";
		const message = err instanceof Error ? err.message : String(err);
		return {
			failure: `importing it failed: ${redactPaths(code ? `${code} ${message}` : message)}`,
		};
	}
	if (!isRecord(mod) || typeof mod.Templates !== "function") {
		return { failure: "it exports no Templates class" };
	}
	try {
		const engine: unknown = Reflect.construct(mod.Templates, [
			{ root: templatesRoot },
		]);
		return isProjectEngine(engine)
			? engine
			: { failure: "its Templates did not construct an object" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { failure: `new Templates() threw: ${redactPaths(message)}` };
	}
}

/** Validate the templates root exists and is a directory, else a shaped error. */
function validateTemplatesRoot(
	projectRoot: string,
	templatesRoot: string,
): ShapedError | null {
	if (!existsSync(templatesRoot)) {
		return shapeError(
			`Templates root not found: ${displayPath(projectRoot, templatesRoot)}`,
			"Pass `root: '<relative-path>'` to point at a non-default location, or create `resources/templates` to use the convention.",
		);
	}
	if (!statSync(templatesRoot).isDirectory()) {
		return shapeError(
			`Templates root is not a directory: ${displayPath(projectRoot, templatesRoot)}`,
			"The `root` argument must resolve to a directory.",
		);
	}
	return null;
}

/**
 * Build one template listing entry. When a syntax checker is present, parse the
 * file and attach any error; a stat failure mid-walk keeps size 0.
 */
function buildTemplateEntry(
	abs: string,
	templatesRoot: string,
	compile: ((source: string, name?: string) => void) | undefined,
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
	if (compile !== undefined) {
		try {
			compile(readFileSync(abs, "utf8"), entry.name);
		} catch (err) {
			entry.error = extractInkerError(err);
		}
	}
	return entry;
}

/** A project-relative, forward-slash path for messages: never the absolute one. */
function displayPath(projectRoot: string, abs: string): string {
	return relative(projectRoot, abs).replace(/\\/g, "/") || ".";
}

/** Pull `{ code, message, line?, column? }` off a thrown inker error. */
function extractInkerError(
	err: unknown,
	fallbackCode = "E_INKER_PARSE_ERROR",
): {
	code: string;
	message: string;
	line?: number;
	column?: number;
} {
	const code =
		isRecord(err) && typeof err.code === "string" ? err.code : fallbackCode;
	const message =
		isRecord(err) && typeof err.message === "string"
			? err.message
			: String(err);
	// An `InkerError` carries its position as Edge's `EdgeError` does: `line`
	// and `col`, 0 when the failure has no line of its own.
	const line =
		isRecord(err) && typeof err.line === "number" && err.line > 0
			? err.line
			: undefined;
	const column =
		isRecord(err) && typeof err.col === "number" && err.col > 0
			? err.col
			: undefined;
	return { code, message, line, column };
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
	const data = isRecord(args.data) ? args.data : {};
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
			`Templates root not found: ${displayPath(projectRoot, templatesRoot)}`,
			"Pass `root: '<relative-path>'` to point at a non-default location.",
		);
	}
	// A template that is a link out of the project (or a name that climbs out
	// of it) would be read by the engine like any other.
	const templateFile = resolve(templatesRoot, `${templateName}.inker`);
	const realTemplate = realpathOfNearest(templateFile);
	const realProject = safeRealpath(projectRoot);
	if (
		realTemplate === null ||
		realProject === null ||
		!isInside(realTemplate, realProject)
	) {
		return shapeError(
			"The template resolves outside the project.",
			"Give a template inside the project — this tool only reads its views.",
		);
	}
	// From the INSPECTED project, like the lint path: ream-mcp does not depend
	// on inker, and rendering against a different version's engine than the app
	// uses would report failures the app does not have.
	const renderer = await loadProjectRenderer(projectRoot, templatesRoot);
	if ("failure" in renderer) {
		return shapeError(
			`Failed to load @c9up/inker from the project: ${renderer.failure}`,
			renderer.failure === "it is not installed in node_modules"
				? "Install it in the project (`ream add @c9up/inker`) before invoking this tool."
				: "The project's @c9up/inker cannot be imported as the application imports it; reinstall it or upgrade it.",
		);
	}
	const tpl = renderer;

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
				t.unref();
			}),
		]);
		return { html };
	} catch (err) {
		const e = extractInkerError(err, "E_INKER_UNKNOWN");
		return {
			error: {
				code: e.code,
				message: redactPaths(e.message),
				line: e.line,
				column: e.column,
			},
			hint: "Helpers `t`, `csrfField`, `url`, `asset` are NOT wired by this tool — templates that depend on them will throw. Use this tool for templates that take data only.",
		};
	}
}
