/**
 * Lightweight tool-list descriptors for `station.*`.
 *
 * Kept in its own file (no `@c9up/station` runtime import) so
 * `server.ts` can answer `tools/list` without pulling in the
 * resource-registry runtime. The actual handler in `station.ts` is
 * dynamic-imported on first dispatch and uses ts-morph for a static
 * `defineResource(...)` scan — no app boot needed.
 */

interface ToolDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export const STATION_TOOLS: ToolDescriptor[] = [
	{
		name: "station.list_resources",
		description:
			"Static scan of `defineResource(...)` calls in the project. Returns each resource's name, entity reference, declared actions, and source file/line — useful to verify which CRUD surface Station exposes without booting the app. Confidence drops to `medium` when arguments aren't string literals (computed names / dynamic entity refs).",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
];

const NAMES = new Set(STATION_TOOLS.map((t) => t.name));

export function isStationTool(name: string): boolean {
	return NAMES.has(name);
}
