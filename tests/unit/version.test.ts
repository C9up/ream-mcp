/**
 * FFI version round-trip — proves the `.node` binary is loaded
 * and `core.version()` returns the value of
 * `crates/ream-mcp-core/Cargo.toml`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { core } from "../../index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CORE_CARGO = join(
	HERE,
	"..",
	"..",
	"crates",
	"ream-mcp-core",
	"Cargo.toml",
);

describe("ream-mcp > napi > core.version()", () => {
	it("returns a non-empty string", () => {
		const v = core.version();
		expect(typeof v).toBe("string");
		expect(v.length).toBeGreaterThan(0);
	});

	it("is semver-shaped (>= 3 dot segments)", () => {
		expect(core.version().split(".").length).toBeGreaterThanOrEqual(3);
	});

	it("matches the value in crates/ream-mcp-core/Cargo.toml", () => {
		const cargo = readFileSync(CORE_CARGO, "utf8");
		const match = cargo.match(/^version\s*=\s*"([^"]+)"/m);
		expect(
			match,
			'Cargo.toml must contain a `version = "..."` line',
		).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: just asserted above
		expect(core.version()).toBe(match![1]);
	});
});
