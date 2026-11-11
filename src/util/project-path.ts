/**
 * Paths in a tool result are project-relative with forward slashes: the
 * contract is "a message, never the machine's layout", successful results
 * included.
 */

import { relative, sep } from "node:path";

export function projectPath(root: string, file: string): string {
	const rel = relative(root, file);
	return rel === "" ? "." : rel.split(sep).join("/");
}
