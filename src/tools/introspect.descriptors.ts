/**
 * Lightweight tool-list descriptors for `introspect.*` (Story 33.3).
 *
 * Kept in its own file (no ts-morph import) so `server.ts` can
 * answer `tools/list` without loading the heavy parser. The actual
 * handlers in `introspect.ts` are dynamic-imported on first dispatch.
 */

interface ToolDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export const INTROSPECT_TOOLS: ToolDescriptor[] = [
	{
		name: "list.routes",
		description:
			"Every HTTP route registered via the project's Router. Groups (prefix/middleware/guards) are flattened. Returns sorted by (method, path).",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "list.entities",
		description:
			"Every `@Entity`-decorated class with columns, relations, and lifecycle hooks (Atlas).",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "list.events",
		description:
			"Every event binding: `bus.subscribe`/`@EventListener` subscribers and `bus.emit`/`bus.dispatch` emitters, grouped by event name (event bus).",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "list.providers",
		description:
			"Every `*Provider` class with lifecycle hooks (register/boot/shutdown) and container bindings.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "list.middleware",
		description:
			"HTTP middleware in pipeline order, extracted from the project's HttpKernel global + named maps.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "get.config",
		description:
			"Static parse of `config/*.ts`. Optional `key` (e.g. `app.name`) descends the tree. Env vars surface as `{ env, default }`; non-literals as `{ unevaluated, expression }`.",
		inputSchema: {
			type: "object",
			properties: {
				key: {
					type: "string",
					description: "Dotted path to descend, e.g. `app.name`.",
				},
			},
			additionalProperties: false,
		},
	},
];

const NAMES = new Set(INTROSPECT_TOOLS.map((t) => t.name));

export function isIntrospectTool(name: string): boolean {
	return NAMES.has(name);
}
