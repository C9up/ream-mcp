/**
 * Tiny helpers shared by `docs.*` and `introspect.*` tool dispatchers.
 * Kept in a private file so neither tool module has to import the
 * other for trivial shape utilities.
 */

/**
 * A tool's JSON result. A top-level `error` field is how every dispatcher
 * reports a refusal or failure (`{ error, hint }`), and the MCP spec wants
 * those flagged `isError: true` so the client and model see the call failed.
 */
export function jsonContent(value: unknown) {
	const failed =
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"error" in value &&
		value.error !== undefined &&
		value.error !== null;
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(value, null, 2),
			},
		],
		...(failed ? { isError: true } : {}),
	};
}

export function errorContent(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
	};
}
