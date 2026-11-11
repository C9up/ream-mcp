/**
 * `doctor.health` is a read-only check: the project it inspects must not pick
 * which `cargo` runs (rustup reads `rust-toolchain.toml` from the cwd and its
 * parents) nor make rustup install a toolchain.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchDoctor } from "../../src/tools/doctor.js";

const RUSTUP_CARGO = join(homedir(), ".cargo", "bin", "cargo");

const VARS = [
	"PATH",
	"RUSTUP_TOOLCHAIN",
	"RUSTUP_AUTO_INSTALL",
	"FAKE_CARGO_MARKER",
] as const;
const saved = new Map<string, string | undefined>();
const savedCwd = process.cwd();
let base: string;

beforeEach(() => {
	for (const v of VARS) saved.set(v, process.env[v]);
	base = mkdtempSync(join(tmpdir(), "doctor-cargo-"));
});

afterEach(() => {
	process.chdir(savedCwd);
	for (const v of VARS) {
		const value = saved.get(v);
		if (value === undefined) delete process.env[v];
		else process.env[v] = value;
	}
	rmSync(base, { recursive: true, force: true });
});

function rustVersion(result: unknown): unknown {
	if (typeof result !== "object" || result === null) return undefined;
	return Object.fromEntries(Object.entries(result)).rustVersion;
}

describe("doctor.health cargo isolation", () => {
	it("runs cargo from the home directory with rustup overrides neutralised", async () => {
		const bin = join(base, "bin");
		mkdirSync(bin);
		const marker = join(base, "marker");
		writeFileSync(
			join(bin, "cargo"),
			[
				"#!/bin/sh",
				'{ pwd -P; printenv RUSTUP_TOOLCHAIN || echo unset; printenv RUSTUP_AUTO_INSTALL || echo unset; } > "$FAKE_CARGO_MARKER"',
				'echo "cargo 9.9.9 (fake)"',
				"",
			].join("\n"),
		);
		chmodSync(join(bin, "cargo"), 0o755);
		process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
		process.env.FAKE_CARGO_MARKER = marker;
		process.env.RUSTUP_TOOLCHAIN = "/repo/chosen/toolchain";
		const project = join(base, "project");
		mkdirSync(project);
		process.chdir(project);

		const result = await dispatchDoctor(project, "doctor.health", {});
		expect(rustVersion(result)).toBe("cargo 9.9.9 (fake)");
		const [cwd, toolchain, autoInstall] = readFileSync(marker, "utf8").split(
			"\n",
		);
		expect(cwd).toBe(realpathSync(homedir()));
		expect(toolchain).toBe("unset");
		expect(autoInstall).toBe("0");
	});

	it("does not resolve cargo from a relative PATH entry", async () => {
		const project = join(base, "project");
		mkdirSync(project);
		writeFileSync(join(project, "cargo"), "#!/bin/sh\necho pwned > PWNED\n");
		chmodSync(join(project, "cargo"), 0o755);
		process.chdir(project);
		process.env.PATH = `.${delimiter}${join(base, "empty")}`;
		const result = await dispatchDoctor(project, "doctor.health", {});
		expect(rustVersion(result)).toBeNull();
		expect(existsSync(join(project, "PWNED"))).toBe(false);
	});

	// Needs rustup at ~/.cargo/bin, as every POSIX CI runner and Rust
	// developer machine has; without it this fails rather than skipping.
	it("ignores a project rust-toolchain.toml that points rustup at a repo binary", async () => {
		const toolchain = join(base, "tc");
		mkdirSync(join(toolchain, "bin"), { recursive: true });
		const pwned = join(base, "PWNED");
		writeFileSync(
			join(toolchain, "bin", "cargo"),
			`#!/bin/sh\necho ran > "${pwned}"\necho "cargo 9.9.9 (fake)"\n`,
		);
		chmodSync(join(toolchain, "bin", "cargo"), 0o755);
		const project = join(base, "project");
		mkdirSync(project);
		writeFileSync(
			join(project, "rust-toolchain.toml"),
			`[toolchain]\npath = "${toolchain}"\n`,
		);
		expect(existsSync(RUSTUP_CARGO)).toBe(true);
		process.env.PATH = `${join(homedir(), ".cargo", "bin")}${delimiter}${process.env.PATH ?? ""}`;
		delete process.env.RUSTUP_TOOLCHAIN;
		process.chdir(project);

		const result = await dispatchDoctor(project, "doctor.health", {});
		expect(existsSync(pwned)).toBe(false);
		expect(rustVersion(result)).not.toBe("cargo 9.9.9 (fake)");
	}, 20_000);
});
