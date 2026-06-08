/**
 * Tiny helpers shared by `docs.*` and `introspect.*` tool dispatchers.
 * Kept in a private file so neither tool module has to import the
 * other for trivial shape utilities.
 */

export function jsonContent(value: unknown) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(value, null, 2),
			},
		],
	};
}

export function errorContent(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
	};
}
