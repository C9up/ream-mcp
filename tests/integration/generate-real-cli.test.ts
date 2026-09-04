/**
 * Smoke test against the REAL Rust `ream` binary — not the Node stub.
 *
 * Catches contract drift between the dispatcher's expectations and the
 * Rust CLI's actual output (file paths, JSON shape, exit codes). The
 * stub-based suites exercise the dispatcher; this one exercises the
 * dispatcher → spawn → real-binary → JSON-parse round trip.
 *
 * Skips when the cargo-built binary is absent so the suite still runs
 * in environments without a Rust toolchain. CI is expected to build
 * the binary before running TS tests.
 */

import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchGenerate } from "../../src/tools/generate.js";
import { canExecInTmp } from "../test-utils.js";

/** Narrow away null/undefined without a `!` assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value");
	return value;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/ream-mcp/tests/integration → packages/ream-cli/target/debug
const CLI_DEBUG = resolve(HERE, "../../../ream-cli/target/debug/ream");
const CLI_RELEASE = resolve(HERE, "../../../ream-cli/target/release/ream");

const REAL_CLI = existsSync(CLI_DEBUG)
	? CLI_DEBUG
	: existsSync(CLI_RELEASE)
		? CLI_RELEASE
		: null;

// Skip when EITHER (a) the Rust CLI isn't built (dev hasn't run
// `cargo build`) OR (b) the system tmpdir refuses exec (noexec-mounted
// /tmp on hardened CIs). beforeEach copies the binary into tmpRoot and
// runs it from there, so a noexec tmp surfaces as EPERM.
const describeIfBuilt = REAL_CLI && canExecInTmp() ? describe : describe.skip;

describeIfBuilt("generate.* against the real ream-cli binary (D1)", () => {
	let tmpRoot: string;
	let prevBin: string | undefined;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "ream-mcp-real-cli-"));
		// Copy the real binary into tmpRoot so the M12 allow-list (which
		// only allows REAM_BIN paths inside the project root or tmpdir)
		// accepts it. The smoke test still validates the dispatcher →
		// real-CLI round trip; the copy is just to satisfy the
		// security guard.
		const dest = join(tmpRoot, "ream");
		copyFileSync(REAL_CLI as string, dest);
		chmodSync(dest, 0o755);
		prevBin = process.env.REAM_BIN;
		process.env.REAM_BIN = dest;
	});

	afterEach(() => {
		if (prevBin === undefined) delete process.env.REAM_BIN;
		else process.env.REAM_BIN = prevBin;
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("dry-run path: dispatcher contract matches Rust JSON output", async () => {
		const res = (await dispatchGenerate(tmpRoot, "generate.controller", {
			module: "orders",
			name: "Orders",
		})) as {
			plannedFiles: Array<{ path: string; content: string; exists: boolean }>;
			confidence: string;
			knownGaps: string[];
		};
		expect(res.plannedFiles).toHaveLength(1);
		expect(defined(res.plannedFiles[0]).path).toBe(
			"app/orders/OrdersController.ts",
		);
		expect(defined(res.plannedFiles[0]).exists).toBe(false);
		expect(defined(res.plannedFiles[0]).content).toContain("OrdersController");
		// The body the CLI planned, not just its name: a controller that does not
		// import HttpContext is not the stub ream-cli ships.
		expect(defined(res.plannedFiles[0]).content).toContain(
			"import type { HttpContext } from '@c9up/ream'",
		);
		expect(res.confidence).toBe("high");
	});

	it("confirm path: writes the file and returns createdFiles[]", async () => {
		const res = (await dispatchGenerate(tmpRoot, "generate.controller", {
			module: "orders",
			name: "Orders",
			confirm: true,
		})) as { createdFiles: string[]; modifiedFiles: string[] };
		expect(res.createdFiles).toEqual(["app/orders/OrdersController.ts"]);
		expect(res.modifiedFiles).toEqual([]);
		const written = readFileSync(
			join(tmpRoot, "app/orders/OrdersController.ts"),
			"utf8",
		);
		expect(written).toContain("OrdersController");
		expect(written).toContain("import type { HttpContext } from '@c9up/ream'");
	});

	it("make:module umbrella: 4 planned files + warnings", async () => {
		const res = (await dispatchGenerate(tmpRoot, "generate.module", {
			module: "orders",
			name: "Order",
		})) as {
			plannedFiles: Array<{ path: string }>;
			warnings: string[];
			confidence: string;
		};
		expect(res.plannedFiles).toHaveLength(4);
		expect(defined(res.plannedFiles[0]).path).toBe("app/orders/Order.ts");
		expect(defined(res.plannedFiles[1]).path).toBe(
			"app/orders/OrderController.ts",
		);
		expect(defined(res.plannedFiles[2]).path).toBe(
			"app/orders/OrderValidator.ts",
		);
		expect(defined(res.plannedFiles[3]).path).toMatch(
			/^database\/migrations\/\d{8}\d{3}_order\.ts$/,
		);
		// Story 33.4 H7: scope-cut warnings must be surfaced.
		expect(res.warnings.some((w) => w.includes("migration filename"))).toBe(
			true,
		);
	});

	// `generate.migration` and `generate.seeder` are not exercised here any more:
	// the binary no longer carries make:migration / make:seeder. They come from
	// @c9up/atlas, through the console kernel, so they need an application with
	// atlas registered rather than the bare project this fixture builds. The
	// argv they produce is covered against the fake CLI in generate-dry-run.
});
