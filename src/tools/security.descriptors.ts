/**
 * Lightweight tool-list descriptors for `security.*`.
 *
 * Same descriptor / handler split as 33.3 / 33.4 / 33.5 / 33.6: this
 * file holds the JSON schema only and is statically imported by
 * `server.ts`. The heavy `security.ts` dispatcher (which loads
 * ts-morph and the six check visitors) is dynamic-imported on
 * first call so the cold-boot path stays under 250 ms.
 */

import { READ_ONLY, type ToolDescriptor } from "./descriptor.js";

export const SECURITY_CHECK_IDS = [
	"sql_interpolation",
	"csrf_disabled",
	"xss_html_raw_output",
	"cookie_missing_flags",
	"missing_guard_on_mutation_route",
	"raw_error_not_reamerror",
] as const;

export type SecurityCheckId = (typeof SECURITY_CHECK_IDS)[number];

export const SECURITY_TOOLS: ToolDescriptor[] = [
	{
		name: "security.scan",
		annotations: READ_ONLY,
		description:
			"Run static security checks against a Ream application's TypeScript sources and inker templates. Read-only, deterministic. Returns `{ findings: [{ id, severity, check, file, line, excerpt, hint, docsUrl }], scanned: { files, templates, directories, skipped }, confidence, knownGaps }`: findings sorted by severity DESC then file/line ASC; `scanned` says what was read (files parsed, templates read, the top-level directories they came from, the directories left unread); `knownGaps` lists what a check could not decide or had nothing to read; `confidence` is `high` only when something was read and `knownGaps` is empty. The whole project root is read; `tests`, `build`, `dist`, `node_modules` and the like are skipped at the top of the root and of each package only. The six checks: sql_interpolation (a value written into the SQL of atlas's rawQuery/raw/execute/*Raw instead of bound), csrf_disabled (blackhole's `csrf: false`, `csrf: { enabled: false }`, or an exceptRoutes entry matching every path), xss_html_raw_output (inker's raw `{{{ }}}`, `new SafeString()` or `html.safe()` around a value that is not escaped), cookie_missing_flags (a `response.cookie()` / `plainCookie()` / `encryptedCookie()` that ends up without Secure, SameSite or HttpOnly, given the ream version's defaults and `http.cookie` in config/app.ts), missing_guard_on_mutation_route (a post/put/patch/delete/resource route with no `.guard()`/`.role()`/`.permission()` naming something, no auth middleware by name, on the route or its group, and no warden `@Guard`/`@Role`/`@Permission` naming something, or `@RequireMfa` where ream's gate enforces it, on the controller action), raw_error_not_reamerror (`new Error()` in a controller instead of a `createError()`/`Exception` error). Pass `checks: [...]` to opt into a subset; an unknown check ID returns a structured error rather than a partial scan.",
		inputSchema: {
			type: "object",
			properties: {
				checks: {
					type: "array",
					description:
						"Optional subset of check IDs to run. When omitted or empty, all six checks run.",
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
