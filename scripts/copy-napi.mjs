// Copies the cargo-built `cdylib` for `ream-mcp-napi` into a
// platform-suffixed `.node` file at the package root, where
// `index.js` expects to load it.

import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { arch, env, platform } from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const CRATE = "ream_mcp_napi";
const TAG = "[ream-mcp:napi]";

// Cross-compile aware: set CARGO_BUILD_TARGET (e.g. x86_64-apple-darwin on an
// arm64 runner so we don't depend on the scarce macos-13 Intel runners) and we
// read target/<triple>/release. Unset = host platform / target/release.
const tripleMap = {
	"x86_64-unknown-linux-gnu": { suffix: "linux-x64-gnu", os: "linux" },
	"aarch64-unknown-linux-gnu": { suffix: "linux-arm64-gnu", os: "linux" },
	"x86_64-apple-darwin": { suffix: "darwin-x64", os: "darwin" },
	"aarch64-apple-darwin": { suffix: "darwin-arm64", os: "darwin" },
	"x86_64-pc-windows-msvc": { suffix: "win32-x64-msvc", os: "win32" },
};
const hostSuffixMap = {
	"linux-x64": "linux-x64-gnu",
	"linux-arm64": "linux-arm64-gnu",
	"darwin-x64": "darwin-x64",
	"darwin-arm64": "darwin-arm64",
	"win32-x64": "win32-x64-msvc",
};

const triple = env.CARGO_BUILD_TARGET ?? "";
let suffix;
let os;
let releaseDir;
if (triple) {
	const entry = tripleMap[triple];
	if (!entry) throw new Error(`${TAG} unsupported CARGO_BUILD_TARGET: ${triple}`);
	suffix = entry.suffix;
	os = entry.os;
	releaseDir = join(root, "target", triple, "release");
} else {
	suffix = hostSuffixMap[`${platform}-${arch}`];
	os = platform;
	releaseDir = join(root, "target", "release");
	if (!suffix) {
		throw new Error(`${TAG} unsupported platform/arch: ${platform}-${arch}`);
	}
}

const candidates =
	os === "win32"
		? [join(releaseDir, `${CRATE}.dll`), join(releaseDir, `lib${CRATE}.dll`)]
		: os === "darwin"
			? [join(releaseDir, `lib${CRATE}.dylib`)]
			: [join(releaseDir, `lib${CRATE}.so`)];

const source = candidates.find((candidate) => existsSync(candidate));
if (!source) {
	throw new Error(
		`${TAG} native library not found. Looked for:\n${candidates.map((p) => `- ${p}`).join("\n")}`,
	);
}

const target = join(root, `index.${suffix}.node`);
copyFileSync(source, target);
process.stderr.write(`${TAG} copied ${source} -> ${target}\n`);
