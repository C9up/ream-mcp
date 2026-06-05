/**
 * Lightweight tool-list descriptors for `inker.*`.
 *
 * Kept in its own file (no `@c9up/inker` runtime import) so
 * `server.ts` can answer `tools/list` without pulling in the lex /
 * parse / render machinery. The actual handlers in `inker.ts` are
 * dynamic-imported on first dispatch.
 */

interface ToolDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export const INKER_TOOLS: ToolDescriptor[] = [
	{
		name: "inker.list_templates",
		description:
			"List every `.inker` template under the project's templates root (default `resources/templates`). Set `lint: true` to additionally lex+parse each template and report any structural errors — catches broken templates without booting the app.",
		inputSchema: {
			type: "object",
			properties: {
				root: {
					type: "string",
					description:
						"Override the templates root (relative to project root). Defaults to `resources/templates` matching @c9up/inker's convention.",
				},
				lint: {
					type: "boolean",
					description:
						"When true, parse each template and surface lex/parse errors per file. Default false.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "inker.render_test",
		description:
			"Render a single `.inker` template against a JSON data object using @c9up/inker's `Templates#render`. NO canonical helpers are wired (t/csrfField/url/asset all throw), so this is for templates that don't depend on the runtime context. Returns the rendered HTML on success, or `{error, hint, line, column}` on a typed InkerRenderError.",
		inputSchema: {
			type: "object",
			properties: {
				template: {
					type: "string",
					description:
						"Template name relative to the templates root, e.g. `pages/welcome`.",
				},
				data: {
					type: "object",
					description:
						"Data object passed as the template's render context. Keys must match the bindings the template expects.",
					additionalProperties: true,
				},
				root: {
					type: "string",
					description:
						"Override the templates root (relative to project root). Defaults to `resources/templates`.",
				},
			},
			required: ["template"],
			additionalProperties: false,
		},
	},
];

const NAMES = new Set(INKER_TOOLS.map((t) => t.name));

export function isInkerTool(name: string): boolean {
	return NAMES.has(name);
}
