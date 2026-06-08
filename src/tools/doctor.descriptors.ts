/**
 * Lightweight tool-list descriptors for `doctor.*` (Story 33.8).
 *
 * Same descriptor / handler split as 33.3–33.7. The heavy
 * `doctor.ts` dispatcher (which shells out to `cargo --version`
 * via the 33.4 cli-runner) is dynamic-imported on first call.
 */

interface ToolDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export const DOCTOR_TOOLS: ToolDescriptor[] = [
	{
		name: "doctor.health",
		description:
			"Report the development environment's health: Node version (from `process.version`), Rust version (via `cargo --version` shell-out), the list of NAPI binaries built across workspace packages, the list of expected-but-missing binaries with build hints, and a `workspaceClean` boolean reflecting manifest-version coherence.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "doctor.env_check",
		description:
			"Validate the project's documented env vars and config files. Returns each env var with a `set: bool` flag (sensitive values are NEVER echoed) and each config file with an `exists: bool` flag plus an actionable hint.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
];

const NAMES = new Set(DOCTOR_TOOLS.map((t) => t.name));

export function isDoctorTool(name: string): boolean {
	return NAMES.has(name);
}
