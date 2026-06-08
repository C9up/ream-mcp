/**
 * Lightweight tool-list descriptors for `generate.*` (Story 33.4).
 *
 * Same descriptor / handler split as 33.3: this file holds the JSON
 * schemas and is statically imported by `server.ts`; the heavy
 * `generate.ts` dispatcher is dynamic-imported on first call so the
 * cold-boot path stays under 250 ms.
 *
 * Defense in depth on shell injection: the JSON Schema below enforces
 * `^[A-Z][A-Za-z0-9]*$` on every class name, the dispatcher in
 * `generate.ts` re-validates with the same regex, the spawn layer
 * (`cli-runner.ts`) passes args as an array (no shell), and the Rust
 * CLI itself runs `validate_class_name` — four layers, any one of
 * which rejects an injection attempt.
 */

interface ToolDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

const CLASS_NAME_PATTERN = "^[A-Z][A-Za-z0-9]*$";
const MODULE_PATTERN = "^[a-z][a-z0-9-]*$";
const MIGRATION_NAME_PATTERN = "^[A-Z][A-Za-z0-9]*$"; // PascalCase, CLI snake-cases internally

const COMMON_FLAGS = {
	dryRun: {
		type: "boolean",
		description:
			"Plan the files without writing anything. Returns plannedFiles[] for agent review. Default: true.",
		default: true,
	},
	confirm: {
		type: "boolean",
		description:
			"Alias for `dryRun: false`. Setting `confirm: true` actually writes the files. Mutually exclusive with `dryRun: true`.",
		default: false,
	},
	force: {
		type: "boolean",
		description:
			"Allow overwriting existing files. Required when any plannedFile.exists is true.",
		default: false,
	},
} as const;

function classScopedSchema(opts: {
	moduleRequired: boolean;
}): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			module: {
				type: "string",
				pattern: MODULE_PATTERN,
				description:
					"Lowercase kebab-case module folder under `app/<module>/`.",
			},
			name: {
				type: "string",
				pattern: CLASS_NAME_PATTERN,
				description: "PascalCase class name (e.g. `Order`).",
			},
			...COMMON_FLAGS,
		},
		required: opts.moduleRequired ? ["module", "name"] : ["name"],
		additionalProperties: false,
	};
}

export const GENERATE_TOOLS: ToolDescriptor[] = [
	{
		name: "generate.module",
		description:
			"Scaffold a full resource: entity + controller + validator + migration under `app/<module>/`. Dry-run by default — returns plannedFiles[] for review.",
		inputSchema: classScopedSchema({ moduleRequired: true }),
	},
	{
		name: "generate.controller",
		description:
			"Scaffold a controller class at `app/<module>/<Name>Controller.ts` with CRUD method stubs.",
		inputSchema: classScopedSchema({ moduleRequired: true }),
	},
	{
		name: "generate.entity",
		description:
			"Scaffold an Atlas `@Entity` class at `app/<module>/<Name>.ts`.",
		inputSchema: classScopedSchema({ moduleRequired: true }),
	},
	{
		name: "generate.migration",
		description:
			"Scaffold an Atlas migration at `database/migrations/<timestamp>_<snake>.ts`. The PascalCase `name` (e.g. `CreateOrdersTable`) is snake-cased for the filename.",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					pattern: MIGRATION_NAME_PATTERN,
					description:
						"PascalCase migration name (e.g. `CreateOrdersTable`). Translated to snake_case in the filename.",
				},
				...COMMON_FLAGS,
			},
			required: ["name"],
			additionalProperties: false,
		},
	},
	{
		name: "generate.seeder",
		description:
			"Scaffold a database seeder at `database/seeders/<Name>Seeder.ts`.",
		inputSchema: {
			type: "object",
			properties: {
				module: {
					type: "string",
					pattern: MODULE_PATTERN,
					description:
						"Module the seeder is scoped to (used in the JSDoc; the file lives under `database/seeders/`).",
				},
				name: {
					type: "string",
					pattern: CLASS_NAME_PATTERN,
					description: "PascalCase seeder name (e.g. `User`).",
				},
				...COMMON_FLAGS,
			},
			required: ["name"],
			additionalProperties: false,
		},
	},
	{
		name: "generate.validator",
		description:
			"Scaffold a Rune validator schema at `app/<module>/<Name>Validator.ts`.",
		inputSchema: classScopedSchema({ moduleRequired: true }),
	},
];

const NAMES = new Set(GENERATE_TOOLS.map((t) => t.name));

export function isGenerateTool(name: string): boolean {
	return NAMES.has(name);
}
