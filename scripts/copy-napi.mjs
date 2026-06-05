// Copies the cargo-built `cdylib` for `ream-mcp-napi` into a
// platform-suffixed `.node` file at the package root, where
// `index.js` expects to load it. Mirrors `packages/atom/scripts/
// copy-napi.mjs`.

import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const suffixMap = {
	"linux-x64": "linux-x64-gnu",
	"linux-arm64": "linux-arm64-gnu",
	"darwin-x64": "darwin-x64",
	"darwin-arm64": "darwin-arm64",
	"win32-x64": "win32-x64-msvc",
};

const suffix = suffixMap[`${platform}-${arch}`];
if (!suffix) {
	throw new Error(
		`[ream-mcp:napi] unsupported platform/arch: ${platform}-${arch}`,
	);
}

// Cargo emits the `.dylib` / `.so` / `.dll` under `target/release/`
// using the crate name with its dash-to-underscore conversion. The
// Cargo.toml `target` is rooted at the package — `target` here is
// `packages/ream-mcp/target/`.
const candidates =
	platform === "win32"
		? [
				join(root, "target", "release", "ream_mcp_napi.dll"),
				join(root, "target", "release", "libream_mcp_napi.dll"),
			]
		: platform === "darwin"
			? [join(root, "target", "release", "libream_mcp_napi.dylib")]
			: [join(root, "target", "release", "libream_mcp_napi.so")];

const source = candidates.find((candidate) => existsSync(candidate));
if (!source) {
	throw new Error(
		`[ream-mcp:napi] native library not found. Looked for:\n${candidates.map((p) => `- ${p}`).join("\n")}\nDid \`cargo build --release -p ream-mcp-napi\` succeed?`,
	);
}

const target = join(root, `index.${suffix}.node`);
copyFileSync(source, target);
process.stderr.write(`[ream-mcp:napi] copied ${source} -> ${target}\n`);
