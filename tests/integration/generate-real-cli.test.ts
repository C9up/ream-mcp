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
		expect(res.plannedFiles[0].path).toBe("app/orders/OrdersController.ts");
		expect(res.plannedFiles[0].exists).toBe(false);
		expect(res.plannedFiles[0].content).toContain("OrdersController");
		expect(res.plannedFiles[0].content).toContain("@implements FR");
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
		expect(written).toContain("@implements FR");
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
		expect(res.plannedFiles[0].path).toBe("app/orders/Order.ts");
		expect(res.plannedFiles[1].path).toBe("app/orders/OrderController.ts");
		expect(res.plannedFiles[2].path).toBe("app/orders/OrderValidator.ts");
		expect(res.plannedFiles[3].path).toMatch(
			/^database\/migrations\/\d{14}[0-9a-z]{4}_order\.ts$/,
		);
		// Story 33.4 H7: scope-cut warnings must be surfaced.
		expect(res.warnings.some((w) => w.includes("migration timestamps"))).toBe(
			true,
		);
	});

	it("real CLI emits a 14-digit timestamp + 4-char base-36 suffix on migrations (M1)", async () => {
		const res = (await dispatchGenerate(tmpRoot, "generate.migration", {
			name: "AddUsers",
		})) as { plannedFiles: Array<{ path: string }> };
		expect(res.plannedFiles[0].path).toMatch(
			/^database\/migrations\/\d{14}[0-9a-z]{4}_add_users\.ts$/,
		);
	});
});
