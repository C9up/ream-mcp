/**
 * The shape every `tools/list` entry takes, shared by the `*.descriptors.ts`
 * files.
 *
 * `annotations` is required so no tool ships without telling the client what
 * it does: a client deciding which calls need the user's approval cannot tell
 * `migration.rollback` from `list.routes` otherwise (an absent `readOnlyHint`
 * means "may modify", an absent `destructiveHint` means "may destroy").
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export interface ToolDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: ToolAnnotations;
}

/** Reads the project and nothing else. */
export const READ_ONLY: ToolAnnotations = {
	readOnlyHint: true,
	openWorldHint: false,
};

/** Changes the project or its database, and may overwrite or drop what is there. */
export const DESTRUCTIVE: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: false,
};
