/**
 * Unit tests for the six `security.scan` checks, on sources written the way
 * a Ream application writes them (routes on the router, warden decorators,
 * atlas raw SQL, blackhole config, inker's SafeString, response cookies).
 *
 * Each check has positive cases (the anti-pattern is found) and negative
 * ones (the Ream way of doing it passes). Sources live in an in-memory
 * ts-morph project per test, so a routes file can follow its controllers.
 */

/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: source-code fixtures intentionally embed `${...}` inside plain-string literals to test the visitors against the literal anti-patterns. */

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import type {
	ProjectFacts,
	Version,
} from "../../src/security/checks/_project.js";
import type {
	CheckDefinition,
	RawFinding,
} from "../../src/security/checks/_types.js";
import { cookieMissingFlags } from "../../src/security/checks/cookie_missing_flags.js";
import { csrfDisabled } from "../../src/security/checks/csrf_disabled.js";
import { missingGuardOnMutationRoute } from "../../src/security/checks/missing_guard_on_mutation_route.js";
import { rawErrorNotReamerror } from "../../src/security/checks/raw_error_not_reamerror.js";
import { sqlInterpolation } from "../../src/security/checks/sql_interpolation.js";
import { xssHtmlRawOutput } from "../../src/security/checks/xss_html_raw_output.js";

/** Narrow away null/undefined without a `!` assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value");
	return value;
}

interface Run {
	findings: RawFinding[];
	knownGaps: string[];
}

/** An application whose ream version is unknown. */
const UNKNOWN_REAM: ProjectFacts = {
	reamVersion: null,
	dependencies: new Set(),
};

/** An application running ream `version` (installed, or the floor of a range). */
function ream(version: Version, exact = true): ProjectFacts {
	return { reamVersion: { version, exact }, dependencies: new Set() };
}

/**
 * Run `check` on `relPath` in a project holding `files` (relative path →
 * source, all under `/proj`).
 */
function scan(
	check: CheckDefinition,
	relPath: string,
	files: Record<string, string>,
	facts: ProjectFacts = UNKNOWN_REAM,
): Run {
	const project = new Project({
		useInMemoryFileSystem: true,
		skipFileDependencyResolution: true,
		skipAddingFilesFromTsConfig: true,
	});
	const fs = project.getFileSystem();
	for (const [path, text] of Object.entries(files)) {
		if (path.endsWith(".json")) fs.writeFileSync(`/proj/${path}`, text);
		else project.createSourceFile(`/proj/${path}`, text);
	}
	const sf = defined(project.getSourceFile(`/proj/${relPath}`));
	const knownGaps: string[] = [];
	const findings = check.run({
		sf,
		relPath,
		project,
		root: "/proj",
		knownGaps,
		facts,
	});
	return { findings, knownGaps };
}

function run(
	check: CheckDefinition,
	relPath: string,
	src: string,
): RawFinding[] {
	return scan(check, relPath, { [relPath]: src }).findings;
}

const lines = (...l: string[]) => l.join("\n");

// -------------------------------------------------- sql_interpolation

describe("sql_interpolation", () => {
	it("flags a value interpolated into `db.rawQuery(...)`", () => {
		const findings = run(
			sqlInterpolation,
			"app/services/users.ts",
			lines(
				"import db from '@c9up/atlas/services/db';",
				"export function find(id: string) {",
				"  return db.rawQuery(`select * from users where id = ${id}`);",
				"}",
			),
		);
		expect(findings).toHaveLength(1);
		expect(defined(findings[0]).check).toBe("sql_interpolation");
		expect(defined(findings[0]).line).toBe(3);
		expect(defined(findings[0]).excerpt).toContain("rawQuery");
	});

	it("flags the builder's `*Raw` methods and a concatenated `execute`", () => {
		const findings = run(
			sqlInterpolation,
			"app/services/products.ts",
			lines(
				"declare const Product: { query(): { whereRaw(s: string): unknown; orderByRaw(s: string): unknown } };",
				"declare const db: { execute(sql: string): unknown };",
				"export function list(min: string, col: string, userId: string) {",
				"  Product.query().whereRaw(`price > ${min}`);",
				"  Product.query().orderByRaw(`${col} desc`);",
				"  db.execute('delete from sessions where user_id = ' + userId);",
				"}",
			),
		);
		expect(findings.map((f) => f.line)).toEqual([4, 5, 6]);
	});

	it("flags `this.schema.raw(...)` with an interpolation in a migration", () => {
		const findings = run(
			sqlInterpolation,
			"database/migrations/0001_users.ts",
			lines(
				"declare const table: string;",
				"export default class {",
				"  schema = { raw(sql: string) { return sql; } };",
				"  up() { this.schema.raw(`create index on ${table} (email)`); }",
				"}",
			),
		);
		expect(findings).toHaveLength(1);
	});

	it("does NOT flag values passed as bindings", () => {
		const findings = run(
			sqlInterpolation,
			"app/services/users.ts",
			lines(
				"import db from '@c9up/atlas/services/db';",
				"declare const User: { query(): { whereRaw(s: string, b: unknown[]): unknown } };",
				"export function find(id: string, min: number) {",
				"  db.rawQuery('select * from users where id = ?', [id]);",
				"  User.query().whereRaw('price > ?', [min]);",
				"  db.raw(`gen_random_uuid()`);",
				"}",
			),
		);
		expect(findings).toEqual([]);
	});

	it("does NOT flag a template literal passed to an unrelated method", () => {
		const findings = run(
			sqlInterpolation,
			"app/services/log.ts",
			lines(
				"declare const logger: { info(m: string): void };",
				"export function log(id: string) { logger.info(`user ${id}`); }",
			),
		);
		expect(findings).toEqual([]);
	});

	it("emits one finding per call site (no double-count via forEachDescendant)", () => {
		const findings = run(
			sqlInterpolation,
			"app/services/users.ts",
			lines(
				"import db from '@c9up/atlas/services/db';",
				"export function f(id: string, role: string) {",
				"  db.rawQuery(`select * from users where id = ${id}`);",
				"  db.rawQuery(`update users set role = ${role} where id = ${id}`);",
				"}",
			),
		);
		expect(findings.map((f) => f.line)).toEqual([3, 4]);
	});
});

// -------------------------------------------------- csrf_disabled

describe("csrf_disabled", () => {
	it("flags `csrf: false` in config/blackhole.ts", () => {
		const findings = run(
			csrfDisabled,
			"config/blackhole.ts",
			lines(
				"import { defineConfig } from '@c9up/blackhole';",
				"export default defineConfig({",
				"  secret: process.env.APP_KEY,",
				"  csrf: false,",
				"});",
			),
		);
		expect(findings).toHaveLength(1);
		expect(defined(findings[0]).line).toBe(4);
	});

	it("flags `csrf: { enabled: false }` and an exceptRoutes entry matching every path", () => {
		const findings = run(
			csrfDisabled,
			"config/blackhole.ts",
			lines(
				"import { defineConfig as blackhole } from '@c9up/blackhole';",
				"export const a = blackhole({ csrf: { enabled: false } });",
				"export const b = blackhole({ csrf: { exceptRoutes: ['/*'] } });",
			),
		);
		expect(findings.map((f) => f.line)).toEqual([2, 3]);
	});

	it("flags the adapters' factories, Hono included", () => {
		const findings = run(
			csrfDisabled,
			"server.ts",
			lines(
				"import { createBlackhole } from '@c9up/blackhole';",
				"import { blackholeHono } from '@c9up/blackhole/hono';",
				"createBlackhole({ csrf: false });",
				"blackholeHono({ csrf: false });",
			),
		);
		expect(findings).toHaveLength(2);
	});

	it("does NOT flag the default, a webhook exemption, or another package's defineConfig", () => {
		const findings = run(
			csrfDisabled,
			"config/blackhole.ts",
			lines(
				"import { defineConfig } from '@c9up/blackhole';",
				"import { defineConfig as sessionConfig } from '@c9up/ream/session';",
				"export const a = defineConfig({ secret: 'k' });",
				"export const b = defineConfig({ csrf: { exceptRoutes: ['/webhooks/*'] } });",
				"export const c = sessionConfig({ csrf: false });",
			),
		);
		expect(findings).toEqual([]);
	});

	it("recognises the config `ream new --template web` writes (defineConfig from @c9up/blackhole/config), for the three ways to turn CSRF off", () => {
		const scaffold = (csrf: string) =>
			lines(
				"import env from '#start/env.js'",
				"import { defineConfig } from '@c9up/blackhole/config'",
				"",
				"export default defineConfig({",
				"  xss: true,",
				`  csrf: ${csrf},`,
				"  secret: env.get('APP_KEY').release(),",
				"})",
			);
		for (const off of [
			"false",
			"{ enabled: false }",
			"{ exceptRoutes: ['/*'] }",
		]) {
			const { findings, knownGaps } = scan(
				csrfDisabled,
				"config/blackhole.ts",
				{
					"config/blackhole.ts": scaffold(off),
				},
			);
			expect(findings.map((f) => f.line)).toEqual([6]);
			expect(knownGaps).toEqual([]);
		}
		// The scaffold as written: CSRF on, nothing exempted.
		expect(
			run(
				csrfDisabled,
				"config/blackhole.ts",
				scaffold("{ exceptRoutes: [] }"),
			),
		).toEqual([]);
	});

	it("reads a plain default export of config/blackhole.ts and a namespace import", () => {
		expect(
			run(
				csrfDisabled,
				"config/blackhole.ts",
				lines(
					"import type { BlackholeConfig } from '@c9up/blackhole';",
					"export default { csrf: false } satisfies BlackholeConfig;",
				),
			).map((f) => f.line),
		).toEqual([2]);
		expect(
			run(
				csrfDisabled,
				"app/security.ts",
				lines(
					"import * as blackhole from '@c9up/blackhole/config';",
					"export const config = blackhole.defineConfig({ csrf: { enabled: false } });",
				),
			).map((f) => f.line),
		).toEqual([2]);
	});

	it("reports in knownGaps what it cannot read instead of passing it", () => {
		const { findings, knownGaps } = scan(csrfDisabled, "config/blackhole.ts", {
			"config/blackhole.ts": lines(
				"import { defineConfig } from '@c9up/blackhole';",
				"declare const settings: object;",
				"declare const flag: boolean;",
				"declare const shared: string[];",
				"export const a = defineConfig({ csrf: settings });",
				"export const b = defineConfig({ csrf: { enabled: flag } });",
				"export const c = defineConfig({ csrf: { exceptRoutes: () => true } });",
				"export const d = defineConfig({ csrf: { exceptRoutes: [...shared] } });",
				"export const e = defineConfig({ ...settings });",
				"export default defineConfig(settings);",
			),
		});
		expect(findings).toEqual([]);
		const unread = (line: number, what: string) =>
			`csrf_disabled: config/blackhole.ts:${line}: ${what} is not a literal; whether it turns CSRF off was not checked`;
		expect(knownGaps).toEqual([
			unread(5, "`csrf`"),
			unread(6, "`csrf.enabled`"),
			unread(7, "`csrf.exceptRoutes`"),
			unread(8, "a `csrf.exceptRoutes` entry"),
			unread(9, "a spread in the blackhole options"),
			"csrf_disabled: config/blackhole.ts:10: the default export is not an options object; whether it turns CSRF off was not checked",
		]);
	});

	it("applies to blackhole configuration files and imports only", () => {
		const project = new Project({ useInMemoryFileSystem: true });
		const config = project.createSourceFile(
			"/p/config/blackhole.ts",
			"export default {}",
		);
		const other = project.createSourceFile(
			"/p/app/x.ts",
			"import { x } from '@c9up/ream';",
		);
		const adapter = project.createSourceFile(
			"/p/app/y.ts",
			"import { blackholeHono } from '@c9up/blackhole/hono';",
		);
		const applies = defined(csrfDisabled.appliesTo);
		expect(applies(config, "config/blackhole.ts")).toBe(true);
		expect(applies(other, "app/x.ts")).toBe(false);
		expect(applies(adapter, "app/y.ts")).toBe(true);
		const nothing = defined(csrfDisabled.nothingRead);
		expect(nothing(UNKNOWN_REAM)).toBeNull();
		expect(
			nothing({
				reamVersion: null,
				dependencies: new Set(["@c9up/blackhole"]),
			}),
		).toContain("no blackhole configuration");
	});
});

// -------------------------------------------------- xss_html_raw_output

describe("xss_html_raw_output", () => {
	it("flags `new SafeString(...)` around a value", () => {
		const findings = run(
			xssHtmlRawOutput,
			"app/helpers/markdown.ts",
			lines(
				"import { SafeString } from '@c9up/inker';",
				"export const body = (input: string) => new SafeString(input);",
				"export const card = (name: string) => new SafeString(`<b>${name}</b>`);",
			),
		);
		expect(findings.map((f) => f.line)).toEqual([2, 3]);
		expect(defined(findings[0]).check).toBe("xss_html_raw_output");
	});

	it("flags the `html.safe(...)` global around a value", () => {
		const findings = run(
			xssHtmlRawOutput,
			"app/helpers/globals.ts",
			lines(
				"declare const html: { safe(v: unknown): unknown };",
				"export const raw = (v: string) => html.safe(v);",
			),
		);
		expect(findings).toHaveLength(1);
	});

	it("does NOT flag markup the code wrote, or values escaped with html.escape", () => {
		const findings = run(
			xssHtmlRawOutput,
			"app/helpers/icons.ts",
			lines(
				"import { SafeString } from '@c9up/inker';",
				"declare const html: { safe(v: unknown): unknown; escape(v: unknown): string };",
				"export const icon = new SafeString('<svg></svg>');",
				"export const tag = (name: string) => new SafeString(`<b>${html.escape(name)}</b>`);",
				"export const text = (v: string) => html.safe(html.escape(v));",
			),
		);
		expect(findings).toEqual([]);
	});
});

// -------------------------------------------------- cookie_missing_flags

describe("cookie_missing_flags", () => {
	it("flags `response.cookie()` without secure and sameSite", () => {
		const findings = run(
			cookieMissingFlags,
			"app/controllers/session_controller.ts",
			lines(
				"import type { HttpContext } from '@c9up/ream';",
				"export default class {",
				"  store({ response }: HttpContext) {",
				"    response.cookie('remember', 'tok', { maxAge: '2h' });",
				"  }",
				"}",
			),
		);
		expect(findings).toHaveLength(1);
		expect(defined(findings[0]).line).toBe(4);
	});

	it("flags plainCookie / encryptedCookie with no options, `secure: false`, or `httpOnly: false`", () => {
		const findings = run(
			cookieMissingFlags,
			"app/controllers/prefs_controller.ts",
			lines(
				"import type { HttpContext } from '@c9up/ream';",
				"export function f(ctx: HttpContext) {",
				"  ctx.response.plainCookie('prefs', { theme: 'dark' });",
				"  ctx.response.encryptedCookie('cart', 'x', { secure: false, sameSite: 'lax' });",
				"  ctx.response.cookie('s', 'x', { secure: true, sameSite: 'lax', httpOnly: false });",
				"  ctx.response.cookie('t', 'x', { secure: true, sameSite: false });",
				"}",
			),
		);
		expect(findings.map((f) => f.line)).toEqual([3, 4, 5, 6]);
	});

	it("does NOT flag a cookie with secure + sameSite (httpOnly defaults on)", () => {
		const findings = run(
			cookieMissingFlags,
			"app/controllers/session_controller.ts",
			lines(
				"import type { HttpContext } from '@c9up/ream';",
				"declare const inProduction: boolean;",
				"export function f({ response }: HttpContext) {",
				"  response.cookie('s', 'x', { secure: true, sameSite: 'lax' });",
				"  response.cookie('t', 'x', { secure: inProduction, sameSite: 'strict' });",
				"}",
			),
		);
		expect(findings).toEqual([]);
	});

	it("does NOT flag reads, clearCookie, or options it cannot see", () => {
		const findings = run(
			cookieMissingFlags,
			"app/controllers/session_controller.ts",
			lines(
				"import type { HttpContext } from '@c9up/ream';",
				"declare const defaults: object;",
				"export function f({ request, response }: HttpContext) {",
				"  request.cookie('s');",
				"  request.cookie('s', 'fallback');",
				"  response.clearCookie('s');",
				"  response.cookie('s', 'x', { ...defaults, maxAge: 1 });",
				"  response.cookie('s', 'x', defaults);",
				"}",
			),
		);
		expect(findings).toEqual([]);
	});

	it("from ream 0.2.32, a cookie that leaves the flags out gets the secure defaults", () => {
		const { findings, knownGaps } = scan(
			cookieMissingFlags,
			"app/controllers/session_controller.ts",
			{
				"app/controllers/session_controller.ts": lines(
					"import type { HttpContext } from '@c9up/ream';",
					"export function f({ response }: HttpContext) {",
					"  response.cookie('a', 'x');",
					"  response.encryptedCookie('b', 'x', { maxAge: '1h' });",
					"  response.cookie('c', 'x', { secure: false });",
					"  response.cookie('d', 'x', { sameSite: undefined });",
					"  response.plainCookie('e', 'x', { httpOnly: undefined });",
					"  response.cookie('f', 'x', { httpOnly: false });",
					"}",
				),
			},
			ream([0, 2, 32]),
		);
		expect(findings.map((f) => f.line)).toEqual([5, 6, 7, 8]);
		expect(knownGaps).toEqual([]);
	});

	it("before ream 0.2.32, a call must pass secure and sameSite itself; an unknown version says so", () => {
		const src = lines(
			"import type { HttpContext } from '@c9up/ream';",
			"export function f({ response }: HttpContext) {",
			"  response.cookie('a', 'x');",
			"  response.cookie('b', 'x', { secure: true, sameSite: 'lax' });",
			"}",
		);
		const files = { "app/controllers/c.ts": src };
		const old = scan(
			cookieMissingFlags,
			"app/controllers/c.ts",
			files,
			ream([0, 2, 31]),
		);
		expect(old.findings.map((f) => f.line)).toEqual([3]);
		expect(old.knownGaps).toEqual([]);
		// `^0.2.16` may resolve to anything from 0.2.16: not proof of the defaults.
		const ranged = scan(
			cookieMissingFlags,
			"app/controllers/c.ts",
			files,
			ream([0, 2, 16], false),
		);
		expect(ranged.findings.map((f) => f.line)).toEqual([3]);
		expect(ranged.knownGaps).toHaveLength(1);
		expect(defined(ranged.knownGaps[0])).toContain(
			"cookie defaults read as before ream 0.2.32",
		);
		const floor = scan(
			cookieMissingFlags,
			"app/controllers/c.ts",
			files,
			ream([0, 2, 32], false),
		);
		expect(floor.findings).toEqual([]);
	});

	it("flags a downgrade of the application's defaults under http.cookie in config/app.ts", () => {
		const named = run(
			cookieMissingFlags,
			"config/app.ts",
			lines(
				"export const http = {",
				"  cookie: { maxAge: '2h', secure: false, sameSite: 'lax', httpOnly: false },",
				"}",
			),
		);
		expect(named.map((f) => f.line)).toEqual([2]);
		const byDefault = run(
			cookieMissingFlags,
			"config/app.ts",
			lines(
				"export default {",
				"  appKey: 'k',",
				"  http: {",
				"    cookie: {",
				"      sameSite: false,",
				"      secure: undefined,",
				"    },",
				"  },",
				"}",
			),
		);
		// `undefined` in http.cookie keeps the default; `false` drops it.
		expect(byDefault.map((f) => f.line)).toEqual([5]);
		expect(
			run(
				cookieMissingFlags,
				"config/app.ts",
				"export const http = { cookie: { secure: true, sameSite: 'strict' } }",
			),
		).toEqual([]);
	});
});

// -------------------------------------------------- missing_guard_on_mutation_route

const ROUTER = "import router from '@c9up/ream/services/router';";

describe("missing_guard_on_mutation_route", () => {
	const controller = lines(
		"export default class PostsController {",
		"  async store() {}",
		"  async update() {}",
		"  async destroy() {}",
		"}",
	);

	it("flags each mutating verb with nothing guarding it", () => {
		const { findings, knownGaps } = scan(
			missingGuardOnMutationRoute,
			"start/routes.ts",
			{
				"start/routes.ts": lines(
					ROUTER,
					"import PostsController from '../app/controllers/posts_controller.js';",
					"router.get('/posts', [PostsController, 'store']);",
					"router.post('/posts', [PostsController, 'store']);",
					"router.put('/posts/:id', [PostsController, 'update']);",
					"router.patch('/posts/:id', [PostsController, 'update']);",
					"router.delete('/posts/:id', [PostsController, 'destroy']);",
					"router.any('/posts/x', [PostsController, 'store']);",
					"router.route('/posts/y', ['GET', 'POST'], [PostsController, 'store']);",
					"router.route('/posts/z', 'GET', [PostsController, 'store']);",
					"router.post('/inline', async () => {});",
				),
				"app/controllers/posts_controller.ts": controller,
			},
		);
		expect(findings.map((f) => f.line)).toEqual([4, 5, 6, 7, 8, 9, 11]);
		expect(defined(findings[0]).check).toBe("missing_guard_on_mutation_route");
		expect(knownGaps).toEqual([]);
	});

	it("accepts .guard(), .role(), .permission() and the auth middleware on the route", () => {
		const { findings } = scan(missingGuardOnMutationRoute, "start/routes.ts", {
			"start/routes.ts": lines(
				ROUTER,
				"import { middleware } from '#start/kernel';",
				"import PostsController from '../app/controllers/posts_controller.js';",
				"router.post('/a', [PostsController, 'store']).guard('web');",
				"router.post('/b', [PostsController, 'store']).as('b').role('admin');",
				"router.post('/c', [PostsController, 'store']).permission('posts.create');",
				"router.post('/d', [PostsController, 'store']).middleware('auth');",
				"router.post('/e', [PostsController, 'store']).use(middleware.auth({ guards: ['web'] }));",
				"router.post('/f', [PostsController, 'store']).use(throttle);",
				"declare const throttle: never;",
			),
			"app/controllers/posts_controller.ts": controller,
		});
		expect(findings.map((f) => f.line)).toEqual([9]);
	});

	it("accepts a guarded group, and the legacy group config", () => {
		const { findings } = scan(missingGuardOnMutationRoute, "start/routes.ts", {
			"start/routes.ts": lines(
				ROUTER,
				"import PostsController from '../app/controllers/posts_controller.js';",
				"router.group(() => {",
				"  router.group(() => {",
				"    router.post('/a', [PostsController, 'store']);",
				"  }).prefix('/v1');",
				"}).prefix('/api').guard('jwt');",
				"router.group({ prefix: '/b', guards: ['jwt'] }, (r) => {",
				"  r.post('/x', [PostsController, 'store']);",
				"});",
				"router.group({ prefix: '/c', middleware: ['auth'] }, (r) => {",
				"  r.post('/x', [PostsController, 'store']);",
				"});",
				"router.group({ prefix: '/d', guards: [] }, (r) => {",
				"  r.post('/x', [PostsController, 'store']);",
				"});",
				"router.group(() => {",
				"  router.post('/e', [PostsController, 'store']);",
				"}).prefix('/open');",
			),
			"app/controllers/posts_controller.ts": controller,
		});
		expect(findings.map((f) => f.line)).toEqual([15, 18]);
	});

	it("accepts warden decorators on the action, through #imports, lazy imports and extends", () => {
		const { findings, knownGaps } = scan(
			missingGuardOnMutationRoute,
			"start/routes.ts",
			{
				"package.json": JSON.stringify({
					imports: { "#controllers/*": "./app/controllers/*.js" },
				}),
				"start/routes.ts": lines(
					ROUTER,
					"import PostsController from '#controllers/posts_controller';",
					"const AdminController = () => import('#controllers/admin_controller');",
					"router.post('/posts', [PostsController, 'store']);",
					"router.delete('/posts/:id', [PostsController, 'destroy']);",
					"router.post('/admin', [AdminController, 'store']);",
					"router.put('/admin', [AdminController, 'update']);",
					"router.post('/admin/open', [AdminController, 'open']);",
				),
				"app/controllers/posts_controller.ts": lines(
					"import { Guard, Role } from '@c9up/warden';",
					"export default class PostsController {",
					"  @Guard('web')",
					"  async store() {}",
					"  @Role('admin')",
					"  async destroy() {}",
					"}",
				),
				"app/controllers/base_controller.ts": lines(
					"import { Permission, RequireMfa } from '@c9up/warden';",
					"export class BaseController {",
					"  @Permission('admin')",
					"  async store() {}",
					"  @RequireMfa()",
					"  async update() {}",
					"  async open() {}",
					"}",
				),
				"app/controllers/admin_controller.ts": lines(
					"import { BaseController } from './base_controller.js';",
					"class AdminController extends BaseController {",
					"  // An override that declares nothing keeps the parent's decorator.",
					"  async update() {}",
					"}",
					"export default AdminController;",
				),
			},
			ream([0, 2, 32]),
		);
		expect(findings.map((f) => f.line)).toEqual([8]);
		expect(knownGaps).toEqual([]);
	});

	it("follows 'Controller.action' handlers registered with router.controllers()", () => {
		const { findings } = scan(missingGuardOnMutationRoute, "start/routes.ts", {
			"start/routes.ts": lines(
				ROUTER,
				"router.controllers({ PostsController: () => import('../app/controllers/posts_controller.js') });",
				"router.post('/a', 'PostsController.store');",
				"router.post('/b', 'PostsController.destroy');",
			),
			"app/controllers/posts_controller.ts": lines(
				"import { Guard } from '@c9up/warden';",
				"export default class PostsController {",
				"  @Guard('web')",
				"  async store() {}",
				"  async destroy() {}",
				"}",
			),
		});
		expect(findings.map((f) => f.line)).toEqual([4]);
	});

	it("checks a resource's store/update/destroy, honouring only/except and per-action middleware", () => {
		const { findings } = scan(missingGuardOnMutationRoute, "start/routes.ts", {
			"start/routes.ts": lines(
				ROUTER,
				"import PostsController from '../app/controllers/posts_controller.js';",
				"router.resource('a', PostsController);",
				"router.resource('b', PostsController).only(['index', 'show']);",
				"router.resource('c', PostsController).use('*', 'auth');",
				"router.resource('d', PostsController).except(['update', 'destroy']).use(['store'], 'auth');",
				"router.resource('e', PostsController).use(['store'], 'auth');",
				"router.resource('f', PostsController).tap((route) => route.guard('web'));",
				"router.shallowResource('g', PostsController).apiOnly();",
			),
			"app/controllers/posts_controller.ts": controller,
		});
		expect(findings.map((f) => f.line)).toEqual([3, 7, 9]);
	});

	it("reports a controller it cannot follow as a known gap, not a finding", () => {
		const { findings, knownGaps } = scan(
			missingGuardOnMutationRoute,
			"start/routes.ts",
			{
				"start/routes.ts": lines(
					ROUTER,
					"import { PostsController } from '@acme/blog';",
					"router.post('/posts', [PostsController, 'store']);",
					"router.post('/x', 'Missing.store');",
				),
			},
		);
		expect(findings).toEqual([]);
		expect(knownGaps).toHaveLength(2);
		expect(defined(knownGaps[0])).toContain("start/routes.ts:3");
		expect(defined(knownGaps[0])).toContain("cannot resolve '@acme/blog'");
	});

	it("does not follow a controller import that climbs out of the project", () => {
		const { findings, knownGaps } = scan(
			missingGuardOnMutationRoute,
			"start/routes.ts",
			{
				"start/routes.ts": lines(
					ROUTER,
					"import Outside from '../../outside/controller.js';",
					"router.post('/x', [Outside, 'store']);",
				),
				// Lands at /outside/controller.ts, next to the project.
				"../outside/controller.ts": lines(
					"import { Guard } from '@c9up/warden';",
					"export default class Outside {",
					"  @Guard('web')",
					"  async store() {}",
					"}",
				),
			},
		);
		expect(findings).toEqual([]);
		expect(knownGaps).toEqual([
			"missing_guard_on_mutation_route: start/routes.ts:3: not decided (cannot resolve '../../outside/controller.js')",
		]);
	});

	it("ignores calls on anything but the router", () => {
		const { findings } = scan(
			missingGuardOnMutationRoute,
			"app/services/http.ts",
			{
				"app/services/http.ts": lines(
					"declare const client: { post(url: string, body: unknown): unknown };",
					"client.post('/remote', {});",
				),
			},
		);
		expect(findings).toEqual([]);
	});

	it("does not count a gate that names nothing (ream refuses it at boot from 0.2.32)", () => {
		const { findings, knownGaps } = scan(
			missingGuardOnMutationRoute,
			"start/routes.ts",
			{
				"start/routes.ts": lines(
					ROUTER,
					"declare const configured: string[];",
					"declare const name: string;",
					"router.post('/a', async () => {}).guard();",
					"router.post('/b', async () => {}).role();",
					"router.post('/c', async () => {}).permission();",
					"router.post('/d', async () => {}).guard('');",
					"router.group(() => {",
					"  router.post('/e', async () => {});",
					"}).guard();",
					"router.resource('f', PostsController).tap((route) => route.guard());",
					"router.post('/g', async () => {}).guard(...configured);",
					"router.post('/h', async () => {}).guard(...['web']);",
					"router.post('/i', async () => {}).guard(name);",
					"router.post('/j', async () => {}).guard().guard('web');",
					"class PostsController { async store() {} async update() {} async destroy() {} }",
				),
			},
		);
		expect(findings.map((f) => f.line)).toEqual([4, 5, 6, 7, 9, 11]);
		expect(knownGaps).toHaveLength(1);
		expect(defined(knownGaps[0])).toContain("start/routes.ts:12");
		expect(defined(knownGaps[0])).toContain(
			".guard() spreads a list that is not a literal",
		);
	});

	it("matches the auth middleware by name, not by a substring", () => {
		const { findings } = scan(missingGuardOnMutationRoute, "start/routes.ts", {
			"start/routes.ts": lines(
				ROUTER,
				"import { middleware } from '#start/kernel';",
				"declare const authorAudit: never, oauthLogger: never;",
				"router.put('/a', async () => {}).use(authorAudit);",
				"router.put('/b', async () => {}).middleware('author');",
				"router.put('/c', async () => {}).use(oauthLogger);",
				"router.put('/d', async () => {}).middleware('unauthenticatedOnly');",
				"router.put('/e', async () => {}).use(middleware.authorize());",
				"router.put('/f', async () => {}).middleware('throttle', 'auth');",
				"router.put('/g', async () => {}).use(middleware.auth);",
				"router.put('/h', async () => {}).use(() => import('#middleware/auth_middleware.js'));",
				"router.put('/i', async () => {}).use([middleware.auth()]);",
				"router.resource('j', PostsController).use('*', 'authorAudit');",
				"router.group({ middleware: ['author'] }, (r) => { r.post('/k', async () => {}) });",
				"router.group({ middleware: ['auth'] }, (r) => { r.post('/l', async () => {}) });",
				"class PostsController { async store() {} async update() {} async destroy() {} }",
			),
		});
		expect(findings.map((f) => f.line)).toEqual([4, 5, 6, 7, 8, 13, 14]);
	});

	it("counts a lone @RequireMfa() only where ream's route gate enforces it", () => {
		const files = {
			"start/routes.ts": lines(
				ROUTER,
				"import AccountsController from '../app/controllers/accounts_controller.js';",
				"router.delete('/account', [AccountsController, 'destroy']);",
			),
			"app/controllers/accounts_controller.ts": lines(
				"import { RequireMfa } from '@c9up/warden';",
				"export default class AccountsController {",
				"  @RequireMfa()",
				"  async destroy() {}",
				"}",
			),
		};
		const current = scan(
			missingGuardOnMutationRoute,
			"start/routes.ts",
			files,
			ream([0, 2, 32]),
		);
		expect(current.findings).toEqual([]);
		expect(current.knownGaps).toEqual([]);
		const old = scan(
			missingGuardOnMutationRoute,
			"start/routes.ts",
			files,
			ream([0, 2, 31]),
		);
		expect(old.findings.map((f) => f.line)).toEqual([3]);
		const unknown = scan(missingGuardOnMutationRoute, "start/routes.ts", files);
		expect(unknown.findings).toEqual([]);
		expect(unknown.knownGaps).toHaveLength(1);
		expect(defined(unknown.knownGaps[0])).toContain(
			"@RequireMfa() alone is enforced",
		);
		const ranged = scan(
			missingGuardOnMutationRoute,
			"start/routes.ts",
			files,
			ream([0, 2, 16], false),
		);
		expect(ranged.knownGaps).toHaveLength(1);
	});

	it("does not count a warden decorator that names nothing", () => {
		const { findings } = scan(missingGuardOnMutationRoute, "start/routes.ts", {
			"start/routes.ts": lines(
				ROUTER,
				"import PostsController from '../app/controllers/posts_controller.js';",
				"router.post('/a', [PostsController, 'store']);",
				"router.put('/b', [PostsController, 'update']);",
				"router.delete('/c', [PostsController, 'destroy']);",
			),
			"app/controllers/posts_controller.ts": lines(
				"import { Guard, Permission, Role } from '@c9up/warden';",
				"export default class PostsController {",
				"  @Role()",
				"  async store() {}",
				"  @Permission()",
				"  async update() {}",
				"  @Guard('web')",
				"  async destroy() {}",
				"}",
			),
		});
		expect(findings.map((f) => f.line)).toEqual([3, 4]);
	});

	it("reports a group config it cannot read in knownGaps; an empty literal list protects nothing", () => {
		const { findings, knownGaps } = scan(
			missingGuardOnMutationRoute,
			"start/routes.ts",
			{
				"start/routes.ts": lines(
					ROUTER,
					"const none: string[] = [];",
					"const guards = ['web'];",
					"declare const config: { guards: string[] };",
					"router.group({ guards: none }, (r) => { r.post('/a', async () => {}) });",
					"router.group({ guards: [...none] }, (r) => { r.post('/b', async () => {}) });",
					"router.group({ guards }, (r) => { r.post('/c', async () => {}) });",
					"router.group(config, (r) => { r.post('/d', async () => {}) });",
					"router.group({ roles: [] }, (r) => { r.post('/e', async () => {}) });",
					"router.group({ permissions: ['posts.write'] }, (r) => { r.post('/f', async () => {}) });",
				),
			},
		);
		expect(findings.map((f) => f.line)).toEqual([9]);
		expect(knownGaps.map((g) => /routes\.ts:(\d+)/.exec(g)?.[1])).toEqual([
			"5",
			"6",
			"7",
			"8",
		]);
	});

	it("applies to a file that declares routes", () => {
		const project = new Project({ useInMemoryFileSystem: true });
		const applies = defined(missingGuardOnMutationRoute.appliesTo);
		const routes = project.createSourceFile("/p/start/routes.ts", ROUTER);
		const slim = project.createSourceFile(
			"/p/bin/server.ts",
			"app.routes((router) => { router.get('/', () => {}) })",
		);
		const other = project.createSourceFile(
			"/p/app/x.ts",
			"client.post('/x', {})",
		);
		expect(applies(routes, "start/routes.ts")).toBe(true);
		expect(applies(slim, "bin/server.ts")).toBe(true);
		expect(applies(other, "app/x.ts")).toBe(false);
	});
});

// -------------------------------------------------- raw_error_not_reamerror

describe("raw_error_not_reamerror", () => {
	it("flags `new Error(...)` and `Error(...)` in a controller", () => {
		const findings = run(
			rawErrorNotReamerror,
			"app/controllers/users_controller.ts",
			lines(
				"export default class UsersController {",
				"  show() {",
				"    throw new Error('not found');",
				"  }",
				"  update() { throw Error('nope'); }",
				"}",
			),
		);
		expect(findings.map((f) => f.line)).toEqual([3, 5]);
		expect(defined(findings[0]).check).toBe("raw_error_not_reamerror");
	});

	it("recognises a module's controllers/ directory and a *Controller.ts file", () => {
		const src = "export class X { f() { throw new Error('boom'); } }";
		expect(
			run(rawErrorNotReamerror, "app/modules/billing/controllers/x.ts", src),
		).toHaveLength(1);
		expect(
			run(rawErrorNotReamerror, "app/http/InvoicesController.ts", src),
		).toHaveLength(1);
	});

	it("does NOT flag createError() / Exception errors, or services decorated with @inject", () => {
		expect(
			run(
				rawErrorNotReamerror,
				"app/controllers/users_controller.ts",
				lines(
					"import { createError, Exception } from '@c9up/ream';",
					"const E_USER_NOT_FOUND = createError('User not found', 'E_USER_NOT_FOUND', 404);",
					"class Suspended extends Exception {}",
					"export default class UsersController {",
					"  show() { throw new E_USER_NOT_FOUND(); }",
					"  update() { throw new Suspended('suspended'); }",
					"}",
				),
			),
		).toEqual([]);
		expect(
			run(
				rawErrorNotReamerror,
				"app/services/users_service.ts",
				lines(
					"import { inject } from '@c9up/ream';",
					"@inject()",
					"export class UsersService { f() { throw new Error('x'); } }",
				),
			),
		).toEqual([]);
	});
});
