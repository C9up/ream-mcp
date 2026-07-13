/**
 * Version-consistency lock. The versions that ship together as one package —
 * the npm `package.json`, the MCP `serverInfo.version` (`PKG_VERSION` in
 * `src/server.ts`), the two Rust crates, and the FFI `core.version()` — MUST
 * agree. A drift means a client sees a stale `serverInfo.version` for a newer
 * install, and the publish workflow (which only gates tag vs package.json)
 * would ship it silently. Audit 2026-07-13.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { core } from "../../index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");

function readVersion(rel: string, re: RegExp): string {
	const match = readFileSync(join(ROOT, rel), "utf8").match(re);
	if (!match || match[1] === undefined) {
		throw new Error(`no version (${re}) in ${rel}`);
	}
	return match[1];
}

describe("ream-mcp > version consistency", () => {
	const pkgVersion = readVersion("package.json", /"version"\s*:\s*"([^"]+)"/);

	it("serverInfo PKG_VERSION matches package.json", () => {
		const serverVersion = readVersion(
			"src/server.ts",
			/const PKG_VERSION\s*=\s*"([^"]+)"/,
		);
		expect(serverVersion).toBe(pkgVersion);
	});

	it("FFI core.version() matches package.json", () => {
		expect(core.version()).toBe(pkgVersion);
	});

	it("both Rust crates match package.json", () => {
		expect(
			readVersion(
				"crates/ream-mcp-core/Cargo.toml",
				/^version\s*=\s*"([^"]+)"/m,
			),
		).toBe(pkgVersion);
		expect(
			readVersion(
				"crates/ream-mcp-napi/Cargo.toml",
				/^version\s*=\s*"([^"]+)"/m,
			),
		).toBe(pkgVersion);
	});
});
