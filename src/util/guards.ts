/**
 * Shape guards for values the server did not produce itself: a parsed
 * `package.json`, a tool argument bag, a JSON string from the native core.
 * Each one checks what it claims instead of asserting it.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
