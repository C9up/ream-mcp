/**
 * Integration test for `generate.*` MCP tools — CONFIRM (write) path.
 *
 * Reuses the Node stub binary from the dry-run suite via REAM_BIN. The
 * stub actually creates files under cwd when --dry-run is absent, so
 * we can assert real disk side-effects.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchGenerate } from "../../src/tools/generate.js";
import { canExecInTmp } from "../test-utils.js";

// Skip when the system tmpdir refuses exec (noexec mount on hardened
// CIs). The suite writes a Node stub under tmpdir() and spawns it via
// REAM_BIN; without exec permission the spawn surfaces as EPERM.
const describeIfTmpExec = canExecInTmp() ? describe : describe.skip;

let tmpRoot: string;
let prevBin: string | undefined;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "ream-mcp-gen-confirm-"));
	prevBin = process.env.REAM_BIN;
	process.env.REAM_BIN = installStubBinary(tmpRoot);
});

afterEach(() => {
	if (prevBin === undefined) delete process.env.REAM_BIN;
	else process.env.REAM_BIN = prevBin;
	rmSync(tmpRoot, { recursive: true, force: true });
});

function installStubBinary(root: string): string {
	const stubBody = `
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const positional = args.filter((a) => !a.startsWith('--'));
const sub = positional[0];
const path = require('node:path');
const fs = require('node:fs');

function planEntry(p, content) {
  return { path: p, content, exists: fs.existsSync(path.join(process.cwd(), p)) };
}

let files = [];
if (sub === 'make:controller') {
  const [_, mod, name] = positional;
  files = [planEntry('app/' + mod + '/' + name + 'Controller.ts', '// ' + name + 'Controller')];
}

if (dryRun) {
  process.stdout.write(JSON.stringify({ files, warnings: [] }) + '\\n');
} else {
  const conflicts = files.filter((f) => f.exists).map((f) => f.path);
  if (!force && conflicts.length > 0) {
    process.stdout.write(JSON.stringify({
      error: 'files already exist',
      hint: 'set --force to overwrite',
      conflicts,
    }) + '\\n');
    // exitCode (not exit()) so Node drains the pipe before terminating;
    // calling exit() right after a buffered write races the flush on slower
    // hosts and produces empty stdout captures upstream.
    process.exitCode = 1;
    return;
  }
  const created = [];
  const modified = [];
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(process.cwd(), f.path)), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), f.path), f.content);
    if (f.exists) modified.push(f.path); else created.push(f.path);
  }
  process.stdout.write(JSON.stringify({
    createdFiles: created,
    modifiedFiles: modified,
    warnings: [],
  }) + '\\n');
}
`.trim();
	const dir = join(root, "node_modules", ".bin");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "ream");
	writeFileSync(path, `#!/usr/bin/env node\n${stubBody}\n`);
	chmodSync(path, 0o755);
	return path;
}

describeIfTmpExec("generate.controller — confirm: true writes files", () => {
	it("creates the file on disk", async () => {
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
	});

	it("returns conflict error without overwriting when force is false", async () => {
		const target = join(tmpRoot, "app/orders/OrdersController.ts");
		mkdirSync(join(tmpRoot, "app/orders"), { recursive: true });
		writeFileSync(target, "// pre-existing");

		const res = (await dispatchGenerate(tmpRoot, "generate.controller", {
			module: "orders",
			name: "Orders",
			confirm: true,
		})) as { error: string; conflicts: string[] };

		expect(res.error).toMatch(/files already exist/);
		expect(res.conflicts).toContain("app/orders/OrdersController.ts");
		// Original file untouched.
		expect(readFileSync(target, "utf8")).toBe("// pre-existing");
	});

	it("overwrites when force: true and confirm: true are both set", async () => {
		const target = join(tmpRoot, "app/orders/OrdersController.ts");
		mkdirSync(join(tmpRoot, "app/orders"), { recursive: true });
		writeFileSync(target, "// pre-existing");

		const res = (await dispatchGenerate(tmpRoot, "generate.controller", {
			module: "orders",
			name: "Orders",
			confirm: true,
			force: true,
		})) as { createdFiles: string[]; modifiedFiles: string[] };

		expect(res.modifiedFiles).toContain("app/orders/OrdersController.ts");
		expect(readFileSync(target, "utf8")).toContain("OrdersController");
	});

	it("missing binary surfaces a structured error", async () => {
		// Remove BOTH the env override stub and the node_modules/.bin
		// fallback so the resolver returns null.
		process.env.REAM_BIN = join(tmpRoot, "does", "not", "exist");
		rmSync(join(tmpRoot, "node_modules"), { recursive: true, force: true });
		const res = (await dispatchGenerate(tmpRoot, "generate.controller", {
			module: "orders",
			name: "Orders",
		})) as { error: string; hint: string };
		expect(res.error).toMatch(/cli failed to spawn/);
		expect(existsSync(tmpRoot)).toBe(true);
	});
});
