/**
 * Lightweight tool-list descriptors for `inker.*`.
 *
 * Kept in its own file (no `@c9up/inker` runtime import) so
 * `server.ts` can answer `tools/list` without pulling in the lex /
 * parse / render machinery. The actual handlers in `inker.ts` are
 * dynamic-imported on first dispatch.
 */

import { RUNS_PROJECT_CODE, type ToolDescriptor } from "./descriptor.js";

export const INKER_TOOLS: ToolDescriptor[] = [
	{
		name: "inker.list_templates",
		annotations: RUNS_PROJECT_CODE,
		description:
			"List every `.inker` template under the project's templates root (default `resources/templates`). Set `lint: true` to additionally lex+parse each template and report any structural errors — catches broken templates without booting the app. With `lint: true` it imports the project's own `@c9up/inker` from its node_modules and runs it in the server process: use it on a project you trust.",
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
		annotations: RUNS_PROJECT_CODE,
		description:
			"Render a single `.inker` template against a JSON data object using @c9up/inker's `Templates#render`. It imports the project's own `@c9up/inker` from its node_modules and runs it in the server process, and the render runs the template's expressions: use it on a project you trust. NO canonical helpers are wired (t/csrfField/url/asset all throw), so this is for templates that don't depend on the runtime context. Returns the rendered HTML on success, or `{error, hint, line, column}` on a typed inker error (an `InkerError`, or one of `errors.E_INKER_*`).",
		inputSchema: {
			type: "object",
			properties: {
				template: {
					type: "string",
					minLength: 1,
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
