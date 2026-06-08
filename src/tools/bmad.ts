/**
 * `bmad.*` MCP tools — Story 33.8.
 *
 * Process-level surface that exposes the project's BMAD plan to
 * the agent: epic / story listing, traceability, gap reporting,
 * and a single write tool (`bmad.update_status`) gated by the
 * 33.4 strict-consent rule.
 *
 * Heavy CJS imports (ts-morph for `reamrc.ts` parsing,
 * package-walker for the gap-report file walk) are dynamic-
 * imported via the server's `loadHandlers` Promise.all so the
 * cold-boot path stays under 250 ms.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
	type ParsedEpic,
	type ParsedStory,
	parseEpicsFile,
	sliceSection,
} from "../util/bmad-parser.js";
import { resolveBmadRoot } from "../util/bmad-resolver.js";
import { walkWorkspacePackages } from "../util/package-walker.js";
import {
	atomicWrite,
	findStatusLine,
	replaceStatusLine,
} from "../util/yaml-atomic.js";
import { BMAD_STATUS_VALUES } from "./bmad.descriptors.js";

export {
	BMAD_TOOLS,
	isBmadTool,
} from "./bmad.descriptors.js";

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
	"fixtures",
]);
const SOURCE_FILE_RE = /\.(?:ts|tsx|rs)$/;
const TEST_FILE_RE = /\.(?:test|spec|fixture)\.tsx?$/;

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findStoryIdMatch(text: string, id: string): number {
	const re = new RegExp(`(?<![\\d.])${escapeRegex(id)}(?![\\d.])`);
	const m = re.exec(text);
	return m ? m.index : -1;
}

function findRequirementMatch(text: string, id: string): number {
	const re = new RegExp(`\\b${escapeRegex(id)}(?!\\d)`);
	const m = re.exec(text);
	return m ? m.index : -1;
}

const BMAD_STATUS_SET = new Set<string>(BMAD_STATUS_VALUES);

// Sprint-status `development_status` keys are kebab-case slugs.
// Restricting `update_status` to this shape prevents callers from
// rewriting top-level metadata such as `generated`, `last_updated`,
// or `tracking_system`.
const STORY_KEY_RE = /^[a-z0-9][a-z0-9-]+$/;

export async function dispatchBmad(
	root: string,
	name: string,
	args: Record<string, unknown> = {},
): Promise<unknown> {
	switch (name) {
		case "bmad.locate":
			return runLocate(root);
		case "bmad.list_epics":
			return runListEpics(root);
		case "bmad.get_story":
			return runGetStory(root, args);
		case "bmad.trace":
			return runTrace(root, args);
		case "bmad.gap_report":
			return runGapReport(root);
		case "bmad.next_story":
			return runNextStory(root, args);
		case "bmad.update_status":
			return runUpdateStatus(root, args);
		default:
			return shapeError(`Unknown bmad tool: ${name}`, "");
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

// ----------------------------------------------------------- locate

function runLocate(root: string): unknown {
	const result = resolveBmadRoot(root);
	if (!result) {
		return shapeError(
			"no BMAD root resolved",
			"set REAM_BMAD_ROOT, add `bmadRoot` to reamrc.ts, or create `_bmad-output/` at the project root",
		);
	}
	return wrap(
		{
			root: result.root,
			tier: result.tier,
			candidates: result.candidates,
		},
		[],
	);
}

// ------------------------------------------------------- list_epics

function runListEpics(root: string): unknown {
	const located = resolveBmadRoot(root);
	if (!located) {
		return shapeError(
			"no BMAD root resolved",
			"call bmad.locate to inspect the resolution trace",
		);
	}
	const epicsPath = join(located.root, "planning-artifacts", "epics.md");
	if (!existsSync(epicsPath)) {
		return shapeError(
			`epics.md not found at ${forwardSlash(relative(root, epicsPath))}`,
			"BMAD root resolved but planning-artifacts/epics.md is missing",
		);
	}
	const text = readFileSync(epicsPath, "utf8");
	const parsed = parseEpicsFile(text);
	const sprintStatus = readSprintStatus(located.root);

	const epics = parsed.epics.map((epic) => ({
		id: epic.id,
		title: epic.title,
		status: lookupEpicStatus(epic.id, sprintStatus, epic.statusBadge),
		storyCount: epic.stories.length,
		stories: epic.stories.map((story) => ({
			id: story.id,
			title: story.title,
			status: lookupStoryStatus(story, sprintStatus),
		})),
	}));

	const knownGaps: string[] = [];
	if (parsed.parserWarnings.length > 0) {
		knownGaps.push(
			`parser surfaced ${parsed.parserWarnings.length} format-drift warning(s)`,
		);
	}
	return wrap(
		{
			parserVersion: parsed.parserVersion,
			parserWarnings: parsed.parserWarnings,
			epics,
		},
		knownGaps,
	);
}

// -------------------------------------------------------- get_story

function runGetStory(root: string, args: Record<string, unknown>): unknown {
	const id = args.id;
	if (typeof id !== "string" || !/^\d+\.\d+$/.test(id)) {
		return shapeError(
			"invalid id",
			"id must be a string in N.M form (e.g. `33.7`)",
		);
	}
	const located = resolveBmadRoot(root);
	if (!located) {
		return shapeError(
			"no BMAD root resolved",
			"call bmad.locate to inspect the resolution trace",
		);
	}

	// 1. Try the implementation-artifact file.
	const artifact = findArtifactFile(located.root, id);
	if (artifact !== null) {
		const body = readFileSync(artifact, "utf8");
		const status = extractArtifactStatus(body);
		const title = extractArtifactTitle(body);
		return wrap(
			{
				source: "implementation-artifact",
				id,
				title,
				status,
				body,
				filePath: forwardSlash(relative(located.root, artifact)),
			},
			[],
		);
	}

	// 2. Fall back to the epic-section slice.
	const epicsPath = join(located.root, "planning-artifacts", "epics.md");
	if (!existsSync(epicsPath)) {
		return shapeError(
			`story ${id} not found and epics.md missing`,
			"create the artifact file or restore epics.md",
		);
	}
	const text = readFileSync(epicsPath, "utf8");
	const parsed = parseEpicsFile(text);
	const story = findStoryInParsed(parsed.epics, id);
	if (!story) {
		return shapeError(
			`story not found: ${id}`,
			"check the id; expected N.M form (e.g. `33.7`)",
		);
	}
	const body = sliceSection(text, story.startLine, story.endLine);
	const sprintStatus = readSprintStatus(located.root);
	return wrap(
		{
			source: "epic-section",
			id,
			title: story.title,
			status: lookupStoryStatus(story, sprintStatus),
			body,
			filePath: forwardSlash(relative(located.root, epicsPath)),
		},
		[],
	);
}

function findArtifactFile(bmadRoot: string, id: string): string | null {
	const dir = join(bmadRoot, "implementation-artifacts");
	if (!existsSync(dir)) return null;
	const prefix = id.replace(".", "-");
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (entry.name.startsWith(`${prefix}-`) && entry.name.endsWith(".md")) {
			return join(dir, entry.name);
		}
	}
	return null;
}

const ARTIFACT_STATUS = /^Status:\s*(\S+)/m;
const ARTIFACT_TITLE = /^#\s+(.+?)$/m;

function extractArtifactStatus(body: string): string {
	const m = ARTIFACT_STATUS.exec(body);
	return m ? m[1] : "unknown";
}

function extractArtifactTitle(body: string): string {
	const m = ARTIFACT_TITLE.exec(body);
	return m ? m[1].trim() : "";
}

function findStoryInParsed(
	epics: ParsedEpic[],
	id: string,
): ParsedStory | null {
	for (const epic of epics) {
		for (const story of epic.stories) {
			if (story.id === id) return story;
		}
	}
	return null;
}

// ------------------------------------------------------------ trace

function runTrace(root: string, args: Record<string, unknown>): unknown {
	const requirementId = args.requirement_id;
	if (typeof requirementId !== "string" || requirementId.length === 0) {
		return shapeError(
			"invalid requirement_id",
			"requirement_id must be a non-empty string",
		);
	}
	const located = resolveBmadRoot(root);
	if (!located) {
		return shapeError(
			"no BMAD root resolved",
			"call bmad.locate to inspect the resolution trace",
		);
	}

	const knownGaps: string[] = [];
	const epicsHits: Array<{ id: string; title: string }> = [];
	const storyHits: Array<{ id: string; title: string; status: string }> = [];

	const epicsPath = join(located.root, "planning-artifacts", "epics.md");
	if (existsSync(epicsPath)) {
		const text = readFileSync(epicsPath, "utf8");
		const parsed = parseEpicsFile(text);
		const sprintStatus = readSprintStatus(located.root);
		const lines = text.split("\n");
		for (const epic of parsed.epics) {
			const epicSlice = lines
				.slice(epic.startLine - 1, epic.endLine)
				.join("\n");
			if (findRequirementMatch(epicSlice, requirementId) >= 0) {
				epicsHits.push({ id: epic.id, title: epic.title });
			}
			for (const story of epic.stories) {
				const storySlice = lines
					.slice(story.startLine - 1, story.endLine)
					.join("\n");
				if (findRequirementMatch(storySlice, requirementId) >= 0) {
					storyHits.push({
						id: story.id,
						title: story.title,
						status: lookupStoryStatus(story, sprintStatus),
					});
				}
			}
		}
	}

	const codeFiles: Array<{ path: string; line: number }> = [];
	const testFiles: Array<{ path: string; line: number }> = [];
	const files = collectProjectFiles(root, knownGaps);
	for (const file of files) {
		const text = safeRead(file);
		if (text === null) continue;
		const idx = findRequirementMatch(text, requirementId);
		if (idx < 0) continue;
		const line = countLinesUpTo(text, idx) + 1;
		const rel = forwardSlash(relative(root, file));
		const target = TEST_FILE_RE.test(basename(file)) ? testFiles : codeFiles;
		target.push({ path: rel, line });
	}

	codeFiles.sort((a, b) => a.path.localeCompare(b.path));
	testFiles.sort((a, b) => a.path.localeCompare(b.path));

	return wrap(
		{
			requirementId,
			epics: epicsHits,
			stories: storyHits,
			codeFiles,
			testFiles,
		},
		knownGaps,
	);
}

// ------------------------------------------------------- gap_report

function runGapReport(root: string): unknown {
	const located = resolveBmadRoot(root);
	if (!located) {
		return shapeError(
			"no BMAD root resolved",
			"call bmad.locate to inspect the resolution trace",
		);
	}
	const epicsPath = join(located.root, "planning-artifacts", "epics.md");
	const knownGaps: string[] = [];

	const epics: ParsedEpic[] = [];
	if (existsSync(epicsPath)) {
		const text = readFileSync(epicsPath, "utf8");
		const parsed = parseEpicsFile(text);
		epics.push(...parsed.epics);
	} else {
		knownGaps.push("planning-artifacts/epics.md not found");
	}

	const requirementIds = collectRequirementIds(located.root);
	const storyIds = epics.flatMap((e) => e.stories.map((s) => s.id));
	const epicsBlob = existsSync(epicsPath)
		? readFileSync(epicsPath, "utf8")
		: "";

	const requirementsWithoutStories = requirementIds
		.filter((req) => findRequirementMatch(epicsBlob, req.id) < 0)
		.map((req) => ({
			id: req.id,
			sourceFile: req.sourceFile,
			line: req.line,
		}));

	// Build the inverse index in one pass: every project file's
	// text → which story ids appear in it.
	const codePresence = new Set<string>();
	const testPresence = new Set<string>();
	const files = collectProjectFiles(root, knownGaps);
	for (const file of files) {
		const text = safeRead(file);
		if (text === null) continue;
		const inTest = TEST_FILE_RE.test(basename(file));
		for (const id of storyIds) {
			if (findStoryIdMatch(text, id) >= 0) {
				if (inTest) testPresence.add(id);
				else codePresence.add(id);
			}
		}
	}

	const storyIndex = new Map<string, ParsedStory>();
	for (const epic of epics) {
		for (const story of epic.stories) storyIndex.set(story.id, story);
	}

	const storiesWithoutCode: Array<{ id: string; title: string }> = [];
	const storiesWithoutTests: Array<{ id: string; title: string }> = [];
	for (const id of storyIds) {
		const story = storyIndex.get(id);
		if (!story) continue;
		if (!codePresence.has(id)) {
			storiesWithoutCode.push({ id, title: story.title });
		}
		if (!testPresence.has(id)) {
			storiesWithoutTests.push({ id, title: story.title });
		}
	}

	return wrap(
		{
			requirementsWithoutStories,
			storiesWithoutCode,
			storiesWithoutTests,
		},
		knownGaps,
	);
}

const REQUIREMENT_ID = /\b(FR|NFR)-(\d+(?:\.\d+)*)\b/g;

function collectRequirementIds(
	bmadRoot: string,
): Array<{ id: string; sourceFile: string; line: number }> {
	const out: Array<{ id: string; sourceFile: string; line: number }> = [];
	const seen = new Set<string>();
	const planningDir = join(bmadRoot, "planning-artifacts");
	if (!existsSync(planningDir)) return out;
	const candidates = ["prd.md", "architecture.md"];
	for (const name of candidates) {
		const full = join(planningDir, name);
		if (!existsSync(full)) continue;
		const text = safeRead(full);
		if (text === null) continue;
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			REQUIREMENT_ID.lastIndex = 0;
			let m: RegExpExecArray | null = REQUIREMENT_ID.exec(lines[i]);
			while (m !== null) {
				const id = `${m[1]}-${m[2]}`;
				if (!seen.has(id)) {
					seen.add(id);
					out.push({ id, sourceFile: name, line: i + 1 });
				}
				m = REQUIREMENT_ID.exec(lines[i]);
			}
		}
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ------------------------------------------------------- next_story

function runNextStory(root: string, args: Record<string, unknown>): unknown {
	const epicFilter = args.epic;
	if (epicFilter !== undefined && typeof epicFilter !== "string") {
		return shapeError("invalid epic", "epic must be a string when set");
	}
	const located = resolveBmadRoot(root);
	if (!located) {
		return shapeError(
			"no BMAD root resolved",
			"call bmad.locate to inspect the resolution trace",
		);
	}
	const epicsPath = join(located.root, "planning-artifacts", "epics.md");
	if (!existsSync(epicsPath)) {
		return shapeError(
			"epics.md not found",
			"BMAD root resolved but planning-artifacts/epics.md is missing",
		);
	}
	const parsed = parseEpicsFile(readFileSync(epicsPath, "utf8"));
	const sprintStatus = readSprintStatus(located.root);

	for (const epic of parsed.epics) {
		if (typeof epicFilter === "string" && epic.id !== epicFilter) continue;
		for (const story of epic.stories) {
			const status = lookupStoryStatus(story, sprintStatus);
			if (status !== "done") {
				return wrap(
					{
						story: {
							id: story.id,
							title: story.title,
							status,
							epic: epic.id,
						},
					},
					[],
				);
			}
		}
	}
	return wrap({ story: null }, []);
}

// ----------------------------------------------------- update_status

function runUpdateStatus(root: string, args: Record<string, unknown>): unknown {
	const id = args.id;
	const status = args.status;
	if (typeof id !== "string" || !STORY_KEY_RE.test(id)) {
		return shapeError(
			"invalid id",
			"id must be a sprint-status development_status key (e.g. `33-8-bmad-bridge-and-doctor`, `epic-33`)",
		);
	}
	if (typeof status !== "string" || !BMAD_STATUS_SET.has(status)) {
		return shapeError(
			`invalid status: ${JSON.stringify(status)}`,
			`status must be one of: ${BMAD_STATUS_VALUES.join(", ")}`,
		);
	}

	const dryRunRaw = args.dryRun;
	const dryRun = dryRunRaw === undefined ? true : dryRunRaw;
	if (typeof dryRun !== "boolean") {
		return shapeError("invalid dryRun", "dryRun must be a boolean");
	}
	const confirmRaw = args.confirm;
	const confirm = confirmRaw === undefined ? false : confirmRaw;
	if (typeof confirm !== "boolean") {
		return shapeError("invalid confirm", "confirm must be a boolean");
	}
	if (!dryRun && confirm !== true) {
		return shapeError(
			"confirm: true required",
			"set confirm: true to actually write; pass dryRun: true to preview the diff",
		);
	}

	const located = resolveBmadRoot(root);
	if (!located) {
		return shapeError(
			"no BMAD root resolved",
			"call bmad.locate to inspect the resolution trace",
		);
	}
	const sprintPath = join(
		located.root,
		"implementation-artifacts",
		"sprint-status.yaml",
	);
	if (!existsSync(sprintPath)) {
		return shapeError(
			`sprint-status.yaml not found at ${forwardSlash(
				relative(root, sprintPath),
			)}`,
			"BMAD root resolved but the sprint-status file is missing",
		);
	}
	const original = readFileSync(sprintPath, "utf8");
	const found = findStatusLine(original, id, { requireIndent: true });
	if (!found) {
		return shapeError(
			`story id not found in sprint-status.yaml: ${id}`,
			"check the key; the YAML key uses dashes (e.g. `33-8-bmad-bridge-and-doctor`)",
		);
	}
	const replaced = replaceStatusLine(original, id, status, {
		requireIndent: true,
	});
	const fileRel = forwardSlash(relative(root, sprintPath));
	if (!replaced.changed) {
		return wrap(
			{
				diff: {
					file: fileRel,
					lineNumber: replaced.lineNumber,
					before: replaced.before,
					after: replaced.after,
				},
				applied: false,
			},
			["status already matches; no write needed"],
		);
	}

	if (dryRun) {
		return wrap(
			{
				diff: {
					file: fileRel,
					lineNumber: replaced.lineNumber,
					before: replaced.before,
					after: replaced.after,
				},
				applied: false,
			},
			[],
		);
	}

	const knownGaps: string[] = [];
	if (process.platform === "win32") {
		knownGaps.push(
			"atomic rename is best-effort on Windows (Node falls back to copyFile + unlink)",
		);
	}
	atomicWrite(sprintPath, replaced.text);
	return wrap(
		{
			diff: {
				file: fileRel,
				lineNumber: replaced.lineNumber,
				before: replaced.before,
				after: replaced.after,
			},
			applied: true,
		},
		knownGaps,
	);
}

// --------------------------------------------------- shared helpers

function readSprintStatus(bmadRoot: string): Map<string, string> {
	const map = new Map<string, string>();
	const path = join(bmadRoot, "implementation-artifacts", "sprint-status.yaml");
	if (!existsSync(path)) return map;
	const text = safeRead(path);
	if (text === null) return map;
	const lines = text.split("\n");
	const re = /^\s+([A-Za-z0-9][\w-]*):\s*([A-Za-z0-9-]+)\s*(?:#.*)?$/;
	let inDevelopmentStatus = false;
	for (const line of lines) {
		if (/^development_status\s*:/.test(line)) {
			inDevelopmentStatus = true;
			continue;
		}
		if (inDevelopmentStatus && /^\S/.test(line)) {
			// Top-level key — exit the development_status map.
			inDevelopmentStatus = false;
		}
		if (!inDevelopmentStatus) continue;
		const m = re.exec(line);
		if (m) map.set(m[1], m[2]);
	}
	return map;
}

function lookupStoryStatus(
	story: ParsedStory,
	sprintStatus: Map<string, string>,
): string {
	// sprint-status.yaml uses keys like `33-8-bmad-bridge-and-doctor`
	// while the parsed story id is `33.8`. Build the prefix and look
	// for any key that starts with it.
	const prefix = `${story.epicId}-${story.storyNum}-`;
	for (const [key, value] of sprintStatus) {
		if (key.startsWith(prefix)) return value;
	}
	return story.statusBadge ?? "backlog";
}

function lookupEpicStatus(
	epicId: string,
	sprintStatus: Map<string, string>,
	badge: string | null,
): string {
	const key = `epic-${epicId}`;
	const value = sprintStatus.get(key);
	if (value) return value;
	return badge ?? "backlog";
}

function collectProjectFiles(root: string, knownGaps: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	let capped = false;
	const push = (p: string): void => {
		if (capped) return;
		if (seen.has(p)) return;
		if (out.length >= FILE_CAP) {
			capped = true;
			knownGaps.push(`corpus search bounded to ${FILE_CAP} files`);
			return;
		}
		seen.add(p);
		out.push(p);
	};
	const packages = walkWorkspacePackages(root);
	if (packages.length > 0) {
		for (const pkg of packages) {
			const dir = existsSync(join(pkg.dir, "src"))
				? join(pkg.dir, "src")
				: pkg.dir;
			walkDir(dir, push);
			if (capped) break;
		}
	} else {
		const fallback = join(root, "src");
		if (existsSync(fallback)) walkDir(fallback, push);
	}
	return out;
}

function walkDir(dir: string, push: (p: string) => void): void {
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
			walkDir(full, push);
			continue;
		}
		if (!entry.isFile()) {
			try {
				const s = statSync(full);
				if (s.isDirectory() && !SKIP_DIRS.has(entry.name)) {
					walkDir(full, push);
					continue;
				}
				if (!s.isFile()) continue;
			} catch {
				continue;
			}
		}
		if (!SOURCE_FILE_RE.test(entry.name)) continue;
		push(full);
	}
}

function safeRead(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function countLinesUpTo(text: string, byteIndex: number): number {
	let count = 0;
	for (let i = 0; i < byteIndex; i++) {
		if (text.charCodeAt(i) === 10) count++;
	}
	return count;
}

function forwardSlash(p: string): string {
	return p.replace(/\\/g, "/");
}
