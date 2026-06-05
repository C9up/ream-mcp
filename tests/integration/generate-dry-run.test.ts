/**
 * Integration test for `generate.*` MCP tools — DRY-RUN path.
 *
 * Uses a Node-based stub binary that mimics the Rust CLI's JSON
 * output. The stub respects --dry-run/--force flags so the dispatcher
 * exercises the full plumbing without depending on cargo at test time.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchGenerate } from "../../src/tools/generate.js";
import { canExecInTmp } from "../test-utils.js";

// Skip when the system tmpdir refuses exec (noexec mount on hardened
// CIs). All `describe` blocks below dispatch through the Node stub
// installed under tmpdir() via REAM_BIN; without exec permission the
// spawn surfaces as EPERM and masks the real test intent.
const describeIfTmpExec = canExecInTmp() ? describe : describe.skip;

let tmpRoot: string;
let prevBin: string | undefined;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "ream-mcp-gen-dry-"));
	prevBin = process.env.REAM_BIN;
	process.env.REAM_BIN = installStubBinary(tmpRoot);
});

afterEach(() => {
	if (prevBin === undefined) delete process.env.REAM_BIN;
	else process.env.REAM_BIN = prevBin;
	rmSync(tmpRoot, { recursive: true, force: true });
});

function installStubBinary(root: string): string {
	// Node-based stub. Reads its own argv and emits a deterministic
	// JSON line on stdout that matches the real CLI's contract.
	const stubBody = `
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const positional = args.filter((a) => !a.startsWith('--'));
const sub = positional[0]; // e.g. 'make:controller'

const path = require('node:path');
const fs = require('node:fs');

function planEntry(p, content) {
  const cwd = process.cwd();
  const abs = path.join(cwd, p);
  return { path: p, content, exists: fs.existsSync(abs) };
}

let files = [];
if (sub === 'make:controller') {
  const [_, mod, name] = positional;
  files = [planEntry('app/' + mod + '/' + name + 'Controller.ts', '// ' + name + 'Controller')];
} else if (sub === 'make:entity') {
  const [_, mod, name] = positional;
  files = [planEntry('app/' + mod + '/' + name + '.ts', '// ' + name + ' entity')];
} else if (sub === 'make:validator') {
  const [_, mod, name] = positional;
  files = [planEntry('app/' + mod + '/' + name + 'Validator.ts', '// ' + name + 'Validator')];
} else if (sub === 'make:seeder') {
  const [_, mod, name] = positional;
  files = [planEntry('database/seeders/' + name + 'Seeder.ts', '// ' + name + 'Seeder')];
} else if (sub === 'make:migration') {
  const [_, name] = positional;
  files = [planEntry('database/migrations/20260101000000_' + name.toLowerCase() + '.ts', '// ' + name + ' migration')];
} else if (sub === 'make:module') {
  const [_, mod, name] = positional;
  files = [
    planEntry('app/' + mod + '/' + name + '.ts', '// ' + name + ' entity'),
    planEntry('app/' + mod + '/' + name + 'Controller.ts', '// ' + name + 'Controller'),
    planEntry('app/' + mod + '/' + name + 'Validator.ts', '// ' + name + 'Validator'),
    planEntry('database/migrations/20260101000000_' + name.toLowerCase() + '.ts', '// ' + name + ' migration'),
  ];
}

if (dryRun) {
  process.stdout.write(JSON.stringify({ files, warnings: [] }) + '\\n');
} else {
  // Refuse to overwrite existing files unless --force.
  const conflicts = files.filter((f) => f.exists).map((f) => f.path);
  if (!force && conflicts.length > 0) {
    process.stdout.write(JSON.stringify({
      error: 'files already exist',
      hint: 'set --force to overwrite',
      conflicts,
    }) + '\\n');
    // exitCode (not exit()) so Node drains the pipe before terminating;
    // calling exit() right after a buffered write races the flush on
    // slower hosts and produces empty stdout captures upstream.
    process.exitCode = 1;
    return;
  }
  // Actually write each planned file.
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

describeIfTmpExec("generate.controller — dry-run by default", () => {
	it("returns plannedFiles[] without writing anything", async () => {
		const res = (await dispatchGenerate(tmpRoot, "generate.controller", {
			module: "orders",
			name: "Orders",
		})) as {
			plannedFiles: Array<{ path: string; content: string; exists: boolean }>;
			warnings: string[];
			confidence: string;
			knownGaps: string[];
		};
		expect(Array.isArray(res.plannedFiles)).toBe(true);
		expect(res.plannedFiles.length).toBe(1);
		expect(res.plannedFiles[0].path).toBe("app/orders/OrdersController.ts");
		expect(res.plannedFiles[0].exists).toBe(false);
		expect(res.confidence).toBe("high");
		expect(res.knownGaps).toEqual([]);
	});

	it("rejects shell-injection attempts before spawn", async () => {
		const res = (await dispatchGenerate(tmpRoot, "generate.controller", {
			module: "orders",
			name: "Orders; rm -rf /",
		})) as { error: string; hint: string };
		expect(res.error).toMatch(/invalid name/);
	});

	it("does NOT spawn the binary when input fails the regex (M9)", async () => {
		// Use the no-shell sandbox: if dispatch ever reaches the spawn
		// layer, runReamCli throws "REAM_MCP_NO_SHELL=1". The
		// validation error must arrive WITHOUT touching the spawn path.
		const prev = process.env.REAM_MCP_NO_SHELL;
		process.env.REAM_MCP_NO_SHELL = "1";
		try {
			const res = (await dispatchGenerate(tmpRoot, "generate.controller", {
				module: "orders",
				name: "Orders; rm -rf /",
			})) as { error: string };
			expect(res.error).toMatch(/invalid name/);
			// Negative assertion: the response is NOT the no-shell
			// error, proving spawn was never attempted.
			expect(res.error).not.toMatch(/REAM_MCP_NO_SHELL/);
		} finally {
			if (prev === undefined) delete process.env.REAM_MCP_NO_SHELL;
			else process.env.REAM_MCP_NO_SHELL = prev;
		}
	});

	it("does NOT spawn the binary when name is missing", async () => {
		const prev = process.env.REAM_MCP_NO_SHELL;
		process.env.REAM_MCP_NO_SHELL = "1";
		try {
			const res = (await dispatchGenerate(tmpRoot, "generate.controller", {
				module: "orders",
			})) as { error: string };
			expect(res.error).toMatch(/missing required argument 'name'/);
			expect(res.error).not.toMatch(/REAM_MCP_NO_SHELL/);
		} finally {
			if (prev === undefined) delete process.env.REAM_MCP_NO_SHELL;
			else process.env.REAM_MCP_NO_SHELL = prev;
		}
	});

	it("rejects when both dryRun and confirm are true", async () => {
		const res = (await dispatchGenerate(tmpRoot, "generate.controller", {
			module: "orders",
			name: "Orders",
			dryRun: true,
			confirm: true,
		})) as { error: string; hint: string };
		expect(res.error).toMatch(/contradictory flags/);
	});

	it("rejects missing required name", async () => {
		const res = (await dispatchGenerate(tmpRoot, "generate.controller", {
			module: "orders",
		})) as { error: string };
		expect(res.error).toMatch(/missing required argument 'name'/);
	});

	it("rejects missing required module on module-scoped tools", async () => {
		const res = (await dispatchGenerate(tmpRoot, "generate.controller", {
			name: "Orders",
		})) as { error: string };
		expect(res.error).toMatch(/missing required argument 'module'/);
	});
});

describeIfTmpExec("generate.module — umbrella", () => {
	it("returns 4 plannedFiles for the resource bundle", async () => {
		const res = (await dispatchGenerate(tmpRoot, "generate.module", {
			module: "orders",
			name: "Order",
		})) as {
			plannedFiles: Array<{ path: string }>;
			confidence: string;
		};
		expect(res.plannedFiles.length).toBe(4);
		expect(res.plannedFiles[0].path).toBe("app/orders/Order.ts");
		expect(res.plannedFiles[1].path).toBe("app/orders/OrderController.ts");
		expect(res.plannedFiles[2].path).toBe("app/orders/OrderValidator.ts");
		expect(res.plannedFiles[3].path).toMatch(
			/^database\/migrations\/\d+_order\.ts$/,
		);
	});
});

describeIfTmpExec("generate.migration — class-scoped name only", () => {
	it("does not require a module argument", async () => {
		const res = (await dispatchGenerate(tmpRoot, "generate.migration", {
			name: "CreateOrders",
		})) as { plannedFiles: Array<{ path: string }> };
		// Migrations now have a 14-digit timestamp + 4-char random suffix
		// before the underscore; just match the deterministic shape.
		expect(res.plannedFiles[0].path).toMatch(
			/^database\/migrations\/\d+_createorders\.ts$/,
		);
	});
});

describeIfTmpExec("generate.seeder — module is optional (H1)", () => {
	it("succeeds without a module argument", async () => {
		const res = (await dispatchGenerate(tmpRoot, "generate.seeder", {
			name: "User",
		})) as {
			plannedFiles: Array<{ path: string }>;
			confidence: string;
		};
		expect(res.plannedFiles[0].path).toBe("database/seeders/UserSeeder.ts");
		expect(res.confidence).toBe("high");
	});

	it("accepts a module argument (used in JSDoc)", async () => {
		const res = (await dispatchGenerate(tmpRoot, "generate.seeder", {
			module: "orders",
			name: "User",
		})) as { plannedFiles: Array<{ path: string }> };
		expect(res.plannedFiles[0].path).toBe("database/seeders/UserSeeder.ts");
	});
});

describeIfTmpExec("dryRun consent rules (H4)", () => {
	it("rejects dryRun:false alone (no confirm token)", async () => {
		const res = (await dispatchGenerate(tmpRoot, "generate.controller", {
			module: "orders",
			name: "Orders",
			dryRun: false,
		})) as { error: string };
		expect(res.error).toMatch(/missing consent/);
	});

	it("rejects dryRun:true AND confirm:true as contradictory", async () => {
		const res = (await dispatchGenerate(tmpRoot, "generate.controller", {
			module: "orders",
			name: "Orders",
			dryRun: true,
			confirm: true,
		})) as { error: string };
		expect(res.error).toMatch(/contradictory flags/);
	});

	it("error responses include confidence:low (H3)", async () => {
		const res = (await dispatchGenerate(tmpRoot, "generate.controller", {
			module: "orders",
			name: "Orders; rm",
		})) as { error: string; confidence: string };
		expect(res.confidence).toBe("low");
	});
});

describeIfTmpExec("8 KB per-file cap surfaces via dispatcher (M10)", () => {
	it("sets contentTruncated + top-level truncated:true + plannedFilesOverflowPath", async () => {
		// Replace the stub with one that emits a >8 KB content.
		mkdirSync(join(tmpRoot, "node_modules", ".bin"), { recursive: true });
		const stub = join(tmpRoot, "node_modules", ".bin", "ream");
		const big = "y".repeat(10_000);
		writeFileSync(
			stub,
			`#!/usr/bin/env node
const payload = ${JSON.stringify({
				files: [
					{
						path: "app/orders/Big.ts",
						content: big,
						exists: false,
					},
				],
				warnings: [],
			})};
process.stdout.write(JSON.stringify(payload) + "\\n");
`,
		);
		chmodSync(stub, 0o755);
		process.env.REAM_BIN = stub;
		const res = (await dispatchGenerate(tmpRoot, "generate.entity", {
			module: "orders",
			name: "Big",
		})) as {
			plannedFiles: Array<{ contentTruncated?: boolean; content: string }>;
			truncated?: boolean;
			plannedFilesOverflowPath?: string;
			knownGaps: string[];
		};
		expect(res.plannedFiles[0].contentTruncated).toBe(true);
		expect(res.truncated).toBe(true);
		expect(res.plannedFilesOverflowPath).toMatch(/planned-files\.log$/);
		expect(res.knownGaps.some((g) => g.includes("8 KB"))).toBe(true);
	});
});

describeIfTmpExec("confidence:medium when CLI emits warnings (L3)", () => {
	it("returns confidence=medium when warnings array is non-empty", async () => {
		// Emit a warning from the stub.
		mkdirSync(join(tmpRoot, "node_modules", ".bin"), { recursive: true });
		const stub = join(tmpRoot, "node_modules", ".bin", "ream");
		writeFileSync(
			stub,
			`#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  files: [{ path: "app/orders/Order.ts", content: "// x", exists: false }],
  warnings: ["barrel export not updated"],
}) + "\\n");
`,
		);
		chmodSync(stub, 0o755);
		process.env.REAM_BIN = stub;
		const res = (await dispatchGenerate(tmpRoot, "generate.entity", {
			module: "orders",
			name: "Order",
		})) as { confidence: string; knownGaps: string[]; warnings: string[] };
		expect(res.confidence).toBe("medium");
		expect(res.knownGaps).toContain("barrel export not updated");
	});
});
