// NAPI loader — picks the correct platform-suffixed `.node` binary and
// re-exports its symbols under a stable surface (`core`).
//
// The binary comes from `index.<suffix>.node` beside this file, which a
// checkout builds (`build:napi`, through `scripts/copy-napi.mjs`), or, when
// that file is absent, from the platform package `@c9up/ream-mcp-<suffix>`:
// one per target, each an optional dependency pinned to this version. A
// published tarball carries no `.node` file, so an install falls through to
// the platform package its package manager picked for this host. A local file
// that exists but fails to load is a broken build, reported as is rather than
// papered over by the package.
//
// This file ships as plain JavaScript, so it cannot import the TypeScript
// sources. It reaches the package's errors through the package's own name
// instead: `@c9up/ream-mcp/errors` resolves through `exports` to
// `src/errors.ts` in the workspace and to `dist/errors.js` once published,
// the same module the server's code imports. Each code is declared once, in
// `src/errors.ts`.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";
import {
	E_REAM_MCP_NATIVE_LOAD_FAILED,
	E_REAM_MCP_UNSUPPORTED_PLATFORM,
} from "@c9up/ream-mcp/errors";

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
	throw new E_REAM_MCP_UNSUPPORTED_PLATFORM([`${platform}-${arch}`]);
}

/** The npm name the platform packages derive from. */
const PACKAGE_NAME = "@c9up/ream-mcp";

/** Node's error code, or a word for an error that carries none. */
function reasonOf(err) {
	return err !== null && typeof err === "object" && typeof err.code === "string"
		? err.code
		: "unreadable binary";
}

/**
 * What to do about the binary that did not load. The load error itself is
 * not in here: it names paths on the host, so it travels as the refusal's
 * `cause` instead of its message.
 */
function remedy(platformPackage) {
	if (platformPackage === undefined) {
		return `index.${suffix}.node failed to load. Rebuild it: cd packages/ream-mcp && pnpm build:napi`;
	}
	const musl =
		platform === "linux"
			? " On Alpine/musl, the gnu binary will not load — build the musl target."
			: "";
	return (
		`install ${platformPackage} at the exact version of ${PACKAGE_NAME}: it is the optional dependency that carries the ${suffix} binary, ` +
		"and an install that omits optional dependencies skips it. " +
		`In a checkout of ream-mcp, build it instead: pnpm build:napi.${musl}`
	);
}

const local = `index.${suffix}.node`;
let native;
try {
	native = require(join(__dirname, local));
} catch (err) {
	// MODULE_NOT_FOUND / dlopen failure → an actionable hint instead of
	// Node's stock error. The message names the binary and Node's error
	// code, never the install directory: the full error, path included,
	// stays on `cause` for whoever debugs it.
	if (reasonOf(err) !== "MODULE_NOT_FOUND") {
		throw new E_REAM_MCP_NATIVE_LOAD_FAILED(
			[local, reasonOf(err), remedy(undefined)],
			{ cause: err },
		);
	}
	const platformPackage = `${PACKAGE_NAME}-${suffix}`;
	try {
		native = require(platformPackage);
	} catch (packageErr) {
		throw new E_REAM_MCP_NATIVE_LOAD_FAILED(
			[platformPackage, reasonOf(packageErr), remedy(platformPackage)],
			{ cause: packageErr },
		);
	}
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
	embeddingModel: native.embeddingModel,
};
