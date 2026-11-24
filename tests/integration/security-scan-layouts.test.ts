/**
 * `security.scan` on applications laid out as `ream new --template web`
 * writes them, plus the layouts that sit next to that one in real projects:
 * a `src/` directory, an internal package, a module whose name is also a
 * build or test folder name. The answer must say what it read, and a scan
 * that had nothing to check must not read as a clean one.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchSecurity } from "../../src/tools/security.js";
import { isRecord } from "../../src/util/guards.js";
import {
	type ScaffoldedApp,
	scaffoldBlackhole,
	scaffoldWebApp,
} from "../scaffold-app.js";

interface Finding {
	check: string;
	file: string;
	line: number;
}

interface Scan {
	findings: Finding[];
	scanned: {
		files: number;
		templates: number;
		directories: string[];
		skipped: string[];
	};
	confidence: string;
	knownGaps: string[];
}

function isStrings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isFinding(value: unknown): value is Finding {
	return (
		isRecord(value) &&
		typeof value.check === "string" &&
		typeof value.file === "string" &&
		typeof value.line === "number"
	);
}

function isScan(value: unknown): value is Scan {
	if (!isRecord(value) || !isRecord(value.scanned)) return false;
	const s = value.scanned;
	return (
		Array.isArray(value.findings) &&
		value.findings.every(isFinding) &&
		typeof s.files === "number" &&
		typeof s.templates === "number" &&
		isStrings(s.directories) &&
		isStrings(s.skipped) &&
		typeof value.confidence === "string" &&
		isStrings(value.knownGaps)
	);
}

async function scanAt(
	root: string,
	args: Record<string, unknown> = {},
): Promise<Scan> {
	const res = await dispatchSecurity(root, "security.scan", args);
	if (!isScan(res))
		throw new Error(`not a scan result: ${JSON.stringify(res)}`);
	return res;
}

const PUBLIC_POST = `import router from '@c9up/ream/services/router'
router.post('/transfer', async () => {})
`;

let app: ScaffoldedApp;
const scan = (args: Record<string, unknown> = {}) => scanAt(app.root, args);
const checks = (res: Scan) =>
	res.findings.map((f) => `${f.check} ${f.file}:${f.line}`).sort();

beforeEach(() => {
	app = scaffoldWebApp();
});
afterEach(() => rmSync(app.root, { recursive: true, force: true }));

describe("security.scan on the web scaffold", () => {
	it("reads the scaffold as written: clean, high confidence, and says what it read", async () => {
		const res = await scan();
		expect(res.findings).toEqual([]);
		expect(res.knownGaps).toEqual([]);
		expect(res.confidence).toBe("high");
		expect(res.scanned.files).toBe(10);
		expect(res.scanned.directories).toEqual([
			".",
			"app",
			"bin",
			"config",
			"providers",
			"start",
		]);
		expect(res.scanned.skipped).toEqual(["tests"]);
	});

	it("finds a public route and CSRF turned off in the scaffold's own files", async () => {
		app.write("start/routes.ts", PUBLIC_POST);
		app.write("config/blackhole.ts", scaffoldBlackhole("false"));
		expect(checks(await scan())).toEqual([
			"csrf_disabled config/blackhole.ts:6",
			"missing_guard_on_mutation_route start/routes.ts:2",
		]);
	});

	for (const [label, csrf] of [
		["csrf: false", "false"],
		["csrf: { enabled: false }", "{ enabled: false }"],
		["csrf: { exceptRoutes: ['/*'] }", "{ exceptRoutes: ['/*'] }"],
	]) {
		it(`flags ${label} in config/blackhole.ts imported from @c9up/blackhole/config`, async () => {
			app.write("config/blackhole.ts", scaffoldBlackhole(csrf));
			const res = await scan({ checks: ["csrf_disabled"] });
			expect(checks(res)).toEqual(["csrf_disabled config/blackhole.ts:6"]);
		});
	}
});

describe("security.scan reads the whole application whatever sits next to it", () => {
	beforeEach(() => {
		app.write("start/routes.ts", PUBLIC_POST);
		app.write("config/blackhole.ts", scaffoldBlackhole("false"));
	});
	const both = [
		"csrf_disabled config/blackhole.ts:6",
		"missing_guard_on_mutation_route start/routes.ts:2",
	];

	it("with a src/ directory", async () => {
		app.write("src/client/main.ts", "export const x = 1\n");
		const res = await scan();
		expect(checks(res)).toEqual(both);
		expect(res.scanned.directories).toContain("src");
	});

	it("with an internal package, whose own tests/ and dist/ are skipped", async () => {
		app.write(
			"packages/ui/package.json",
			'{"name":"@demo/ui","main":"src/index.ts"}',
		);
		app.write("packages/ui/src/index.ts", "export const x = 1\n");
		app.write(
			"packages/ui/src/admin.ts",
			"import router from '@c9up/ream/services/router'\nrouter.delete('/ui', async () => {})\n",
		);
		app.write("packages/ui/tests/fixture.ts", PUBLIC_POST);
		app.write("packages/ui/dist/index.ts", PUBLIC_POST);
		const res = await scan();
		expect(checks(res)).toEqual([
			"csrf_disabled config/blackhole.ts:6",
			"missing_guard_on_mutation_route packages/ui/src/admin.ts:2",
			"missing_guard_on_mutation_route start/routes.ts:2",
		]);
		expect(res.scanned.skipped).toEqual([
			"packages/ui/dist",
			"packages/ui/tests",
			"tests",
		]);
		expect(res.knownGaps).toEqual([]);
	});

	for (const dir of [
		"build",
		"out",
		"test",
		"spec",
		"e2e",
		"fixtures",
		"dist",
		"coverage",
	]) {
		it(`with a module named '${dir}' (below the top level it is application code)`, async () => {
			app.write(`app/modules/${dir}/routes.ts`, PUBLIC_POST);
			const res = await scan({ checks: ["missing_guard_on_mutation_route"] });
			expect(checks(res)).toEqual([
				`missing_guard_on_mutation_route app/modules/${dir}/routes.ts:2`,
				"missing_guard_on_mutation_route start/routes.ts:2",
			]);
			expect(res.confidence).toBe("high");
		});
	}

	it("names a directory of application code it left unread, and lowers the confidence", async () => {
		app.write("app/modules/billing/.generated/routes.ts", PUBLIC_POST);
		mkdirSync(join(app.root, "app/modules/billing/node_modules"), {
			recursive: true,
		});
		const res = await scan();
		expect(res.scanned.skipped).toEqual([
			"app/modules/billing/.generated",
			"app/modules/billing/node_modules",
			"tests",
		]);
		expect(res.knownGaps).toEqual([
			"directory not scanned: app/modules/billing/.generated",
			"directory not scanned: app/modules/billing/node_modules",
		]);
		expect(res.confidence).toBe("medium");
	});
});

describe("security.scan says when a check had nothing to read", () => {
	it("no file declares routes", async () => {
		rmSync(join(app.root, "start/routes.ts"));
		rmSync(join(app.root, "start/kernel.ts"));
		const res = await scan({ checks: ["missing_guard_on_mutation_route"] });
		expect(res.findings).toEqual([]);
		expect(res.knownGaps).toEqual([
			"missing_guard_on_mutation_route: no file declaring routes was read (start/routes.ts, a module's routes.ts, or a file importing @c9up/ream/services/router)",
		]);
		expect(res.confidence).toBe("medium");
	});

	it("blackhole is a dependency and no configuration of it was read", async () => {
		rmSync(join(app.root, "config/blackhole.ts"));
		rmSync(join(app.root, "start/kernel.ts"));
		const res = await scan({ checks: ["csrf_disabled"] });
		expect(res.knownGaps).toEqual([
			"csrf_disabled: @c9up/blackhole is a dependency but no blackhole configuration (config/blackhole.ts, defineConfig, createBlackhole or an adapter) was read",
		]);
		expect(res.confidence).toBe("medium");
	});

	it("an application with no source file at all is never `high`", async () => {
		for (const dir of ["app", "bin", "config", "providers", "start"]) {
			rmSync(join(app.root, dir), { recursive: true });
		}
		rmSync(join(app.root, "reamrc.ts"));
		const res = await scan({ checks: ["sql_interpolation"] });
		expect(res.scanned.files).toBe(0);
		expect(res.knownGaps).toEqual(["no source files found"]);
		expect(res.confidence).toBe("medium");
	});
});

describe("security.scan reads the ream version the application runs", () => {
	const ACCOUNTS = `import { RequireMfa } from '@c9up/warden'
export default class AccountsController {
  @RequireMfa()
  async destroy() {}
}
`;
	const ROUTES = `import router from '@c9up/ream/services/router'
const AccountsController = () => import('#app/controllers/accounts_controller.js')
router.delete('/account', [AccountsController, 'destroy'])
`;
	const install = (version: string) => {
		app.write(
			"node_modules/@c9up/ream/package.json",
			JSON.stringify({ name: "@c9up/ream", version }),
		);
	};

	it("the installed version wins over the declared range", async () => {
		app.write("app/controllers/accounts_controller.ts", ACCOUNTS);
		app.write("start/routes.ts", ROUTES);
		expect((await scan()).findings).toEqual([]);
		install("0.2.31");
		expect(checks(await scan())).toEqual([
			"missing_guard_on_mutation_route start/routes.ts:3",
		]);
	});

	it("a workspace range gives no version: a lone @RequireMfa() is a known gap", async () => {
		app.write(
			"package.json",
			JSON.stringify({
				name: "demo",
				type: "module",
				imports: { "#app/*": "./app/*" },
				dependencies: { "@c9up/ream": "workspace:*" },
			}),
		);
		app.write("app/controllers/accounts_controller.ts", ACCOUNTS);
		app.write("start/routes.ts", ROUTES);
		const res = await scan({ checks: ["missing_guard_on_mutation_route"] });
		expect(res.findings).toEqual([]);
		expect(res.knownGaps).toHaveLength(1);
		expect(res.knownGaps[0]).toContain("@RequireMfa() alone is enforced");
		expect(res.confidence).toBe("medium");
	});

	it("cookie defaults: config/app.ts is read for http.cookie", async () => {
		const only = { checks: ["cookie_missing_flags"] };
		app.write(
			"app/controllers/prefs_controller.ts",
			`import type { HttpContext } from '@c9up/ream'
export default class PrefsController {
  async store({ response }: HttpContext) {
    response.cookie('theme', 'dark')
  }
}
`,
		);
		expect((await scan(only)).findings).toEqual([]);

		app.write(
			"config/app.ts",
			"export const http = { cookie: { secure: false } }\n",
		);
		expect(checks(await scan(only))).toEqual([
			"cookie_missing_flags config/app.ts:1",
		]);

		app.write(
			"config/app.ts",
			"declare const shared: object\nexport const http = { cookie: shared }\n",
		);
		const unreadable = await scan(only);
		expect(unreadable.findings).toEqual([]);
		expect(unreadable.knownGaps).toEqual([
			"cookie_missing_flags: http.cookie in config/app.ts is not a literal object; the cookie defaults it sets were not checked",
		]);

		install("0.2.31");
		app.write("config/app.ts", "export const http = {}\n");
		expect(checks(await scan(only))).toEqual([
			"cookie_missing_flags app/controllers/prefs_controller.ts:4",
		]);
	});
});
