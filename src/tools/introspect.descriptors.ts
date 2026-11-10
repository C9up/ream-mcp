/**
 * Lightweight tool-list descriptors for `introspect.*` (Story 33.3).
 *
 * Kept in its own file (no ts-morph import) so `server.ts` can
 * answer `tools/list` without loading the heavy parser. The actual
 * handlers in `introspect.ts` are dynamic-imported on first dispatch.
 */

import { READ_ONLY, type ToolDescriptor } from "./descriptor.js";

export const INTROSPECT_TOOLS: ToolDescriptor[] = [
	{
		name: "list.routes",
		annotations: READ_ONLY,
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
		annotations: READ_ONLY,
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
		annotations: READ_ONLY,
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
		annotations: READ_ONLY,
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
		annotations: READ_ONLY,
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
		annotations: READ_ONLY,
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
