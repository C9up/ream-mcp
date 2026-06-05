// NAPI loader — picks the correct platform-suffixed `.node` binary
// emitted by `scripts/copy-napi.mjs` and re-exports its symbols
// under a stable surface (`core`).

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const platformMap = {
	"linux-x64": "linux-x64-gnu",
	"linux-arm64": "linux-arm64-gnu",
	"darwin-x64": "darwin-x64",
	"darwin-arm64": "darwin-arm64",
	"win32-x64": "win32-x64-msvc",
};

const suffix = platformMap[`${platform}-${arch}`];
if (!suffix) {
	throw new Error(`[ream-mcp] unsupported platform: ${platform}-${arch}`);
}

let native;
try {
	native = require(join(__dirname, `index.${suffix}.node`));
} catch (err) {
	// MODULE_NOT_FOUND / dlopen failure → wrap with an actionable
	// hint instead of bubbling up Node's stock error. The most
	// common cause is "you cloned the repo and didn't run the
	// Rust build yet".
	const cause = err instanceof Error ? `${err.message}` : String(err);
	throw new Error(
		`[ream-mcp] failed to load native binary 'index.${suffix}.node' from ${__dirname}. ` +
			`Run \`pnpm --filter @c9up/ream-mcp build:napi\` to build it, or set up CI prebuilds. ` +
			`Underlying error: ${cause}`,
		{ cause: err },
	);
}

// Stable namespace — TS code imports `import { core } from
// "@c9up/ream-mcp/napi"` and calls `core.version()`. New NAPI
// exports flow through this same `core` object.
export const core = {
	version: native.version,
	indexCorpus: native.indexCorpus,
	search: native.search,
	getChunk: native.getChunk,
	trace: native.trace,
	auditDrift: native.auditDrift,
};
