/**
 * Lightweight tool-list descriptors for `security.*` (Story 33.7).
 *
 * Same descriptor / handler split as 33.3 / 33.4 / 33.5 / 33.6: this
 * file holds the JSON schema only and is statically imported by
 * `server.ts`. The heavy `security.ts` dispatcher (which loads
 * ts-morph and the seven check visitors) is dynamic-imported on
 * first call so the cold-boot path stays under 250 ms.
 */

interface ToolDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export const SECURITY_CHECK_IDS = [
	"sql_interpolation",
	"csrf_disabled",
	"xss_html_raw_output",
	"cookie_missing_flags",
	"reflect_metadata_missing",
	"missing_guard_on_mutation_route",
	"raw_error_not_reamerror",
] as const;

export type SecurityCheckId = (typeof SECURITY_CHECK_IDS)[number];

export const SECURITY_TOOLS: ToolDescriptor[] = [
	{
		name: "security.scan",
		description:
			"Run targeted static-security checks against the project's TypeScript sources. Read-only, deterministic. Returns `{ findings: [{ id, severity, check, file, line, excerpt, hint, docsUrl }] }` sorted by severity DESC then file/line ASC. Default check set covers the seven Ream anti-patterns: sql_interpolation, csrf_disabled, xss_html_raw_output, cookie_missing_flags, reflect_metadata_missing, missing_guard_on_mutation_route, raw_error_not_reamerror. Pass `checks: [...]` to opt into a subset; an unknown check ID returns a structured error rather than a partial scan.",
		inputSchema: {
			type: "object",
			properties: {
				checks: {
					type: "array",
					description:
						"Optional subset of check IDs to run. When omitted or empty, all seven default checks run.",
					items: {
						type: "string",
						enum: [...SECURITY_CHECK_IDS],
					},
				},
			},
			additionalProperties: false,
		},
	},
];

const NAMES = new Set(SECURITY_TOOLS.map((t) => t.name));

export function isSecurityTool(name: string): boolean {
	return NAMES.has(name);
}
