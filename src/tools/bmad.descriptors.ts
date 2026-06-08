/**
 * Lightweight tool-list descriptors for `bmad.*` (Story 33.8).
 *
 * Same descriptor / handler split as 33.3–33.7: this file holds
 * the JSON schemas only. The heavy `bmad.ts` dispatcher (which
 * loads the heading walker + yaml rewriter) is dynamic-imported
 * on first call so the cold-boot path stays under 250 ms.
 */

interface ToolDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export const BMAD_STATUS_VALUES = [
	"backlog",
	"ready-for-dev",
	"in-progress",
	"review",
	"done",
] as const;

export type BmadStatus = (typeof BMAD_STATUS_VALUES)[number];

export const BMAD_TOOLS: ToolDescriptor[] = [
	{
		name: "bmad.locate",
		description:
			"Resolve the project's BMAD root using a 5-tier priority: (1) `bmadRoot` field in `reamrc.ts`, (2) `REAM_BMAD_ROOT` env, (3) `<root>/_bmad-output/`, (4) `<root>/ream-legacy/_bmad-output/`, (5) `<root>/.bmad/`. First existing path wins. Returns the resolved path plus the full candidate trace so callers can debug resolution.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "bmad.list_epics",
		description:
			"Parse `epics.md` and return every epic with its nested stories. Heading match is lenient (emoji prefixes, trailing status badges, indented variants). Status is merged from `sprint-status.yaml` when present; otherwise stories default to `backlog`. Output is deterministic — sorted by epic id, then story id.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "bmad.get_story",
		description:
			"Return the full body of a story by id (e.g. `33.7`). Resolves to the implementation-artifact file when present (`<bmadRoot>/implementation-artifacts/33-7-*.md`), otherwise slices the corresponding section from `epics.md`.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Story id like `33.7`. Required.",
				},
			},
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "bmad.trace",
		description:
			"Trace a requirement id (e.g. `FR-12`, `NFR-3.5`) through the BMAD corpus and the project source tree: epics that mention it, stories that mention it, code files containing the literal id, and test files containing it. Plain-text grep, not AST.",
		inputSchema: {
			type: "object",
			properties: {
				requirement_id: {
					type: "string",
					description:
						"Requirement id like `FR-12` or `NFR-3.5`. Plain-text match.",
				},
			},
			required: ["requirement_id"],
			additionalProperties: false,
		},
	},
	{
		name: "bmad.gap_report",
		description:
			"Return three lists of gaps surfaced by cross-referencing the BMAD corpus with the project source: requirements without stories, stories without code references, stories without test references. Detection is plain-text — a story id mentioned in JSDoc still counts as covered.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "bmad.next_story",
		description:
			"Return the first story whose status is not `done`, in epic-then-story-id order. Pass `epic` to scope the search to a single epic.",
		inputSchema: {
			type: "object",
			properties: {
				epic: {
					type: "string",
					description: "Optional epic id (e.g. `33`) to scope the search.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "bmad.update_status",
		description:
			"Update a story's status in `sprint-status.yaml`. Dry-run by default: returns the line diff that would be applied without mutating the file. `dryRun: false` requires `confirm: true` (strict-consent rule from 33.4); writes the change atomically (sibling tempfile + rename in same dir). Status must be one of `backlog | ready-for-dev | in-progress | review | done`.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description:
						"Story id like `33-8-bmad-bridge-and-doctor` (the sprint-status.yaml key). Required.",
				},
				status: {
					type: "string",
					enum: [...BMAD_STATUS_VALUES],
					description: "Target status. Required.",
				},
				dryRun: {
					type: "boolean",
					default: true,
					description:
						"When true (default), preview the diff without applying. When false, requires `confirm: true`.",
				},
				confirm: {
					type: "boolean",
					default: false,
					description: "Required when dryRun is false.",
				},
			},
			required: ["id", "status"],
			additionalProperties: false,
		},
	},
];

const NAMES = new Set(BMAD_TOOLS.map((t) => t.name));

export function isBmadTool(name: string): boolean {
	return NAMES.has(name);
}
