/**
 * Unit tests for the seven `security.scan` checks (Story 33.7).
 *
 * Each check has a positive fixture (anti-pattern detected) and
 * a negative fixture (canonical fix passes clean). Fixtures live
 * in an in-memory ts-morph project per test, isolated via
 * `beforeEach`.
 */

/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: source-code fixtures intentionally embed `${...}` inside plain-string literals to test the visitors against the literal anti-patterns. */

import { Project, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";
import type {
	CheckContext,
	CheckDefinition,
} from "../../src/security/checks/_types.js";
import { cookieMissingFlags } from "../../src/security/checks/cookie_missing_flags.js";
import { csrfDisabled } from "../../src/security/checks/csrf_disabled.js";
import { missingGuardOnMutationRoute } from "../../src/security/checks/missing_guard_on_mutation_route.js";
import { rawErrorNotReamerror } from "../../src/security/checks/raw_error_not_reamerror.js";
import { reflectMetadataMissing } from "../../src/security/checks/reflect_metadata_missing.js";
import { sqlInterpolation } from "../../src/security/checks/sql_interpolation.js";
import { xssHtmlRawOutput } from "../../src/security/checks/xss_html_raw_output.js";

function makeCtx(
	relPath: string,
	source: string,
	entryFile: string | null = relPath,
): CheckContext {
	const project = new Project({
		useInMemoryFileSystem: true,
		skipFileDependencyResolution: true,
		skipAddingFilesFromTsConfig: true,
	});
	const sf: SourceFile = project.createSourceFile(`/proj/${relPath}`, source);
	return { sf, relPath, project, root: "/proj", entryFile };
}

function run(
	check: CheckDefinition,
	relPath: string,
	src: string,
	entryFile: string | null | undefined = undefined,
) {
	// `null` is intentional and means "no entry resolved";
	// `undefined` means "default to relPath" (the common test case).
	const resolved = entryFile === undefined ? relPath : entryFile;
	return check.run(makeCtx(relPath, src, resolved));
}

// -------------------------------------------------- sql_interpolation

describe("sql_interpolation", () => {
	it("flags `db.query(`...${x}...`)`", () => {
		const findings = run(
			sqlInterpolation,
			"src/users.ts",
			[
				"declare const db: { query(sql: string): unknown };",
				"declare const userId: string;",
				"function find() {",
				"  return db.query(`SELECT * FROM users WHERE id = ${userId}`);",
				"}",
			].join("\n"),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].check).toBe("sql_interpolation");
		expect(findings[0].line).toBe(4);
		expect(findings[0].excerpt).toContain("SELECT");
	});

	it("does NOT flag prepared-statement placeholders", () => {
		const findings = run(
			sqlInterpolation,
			"src/users.ts",
			[
				"declare const db: { query(sql: string, params?: unknown[]): unknown };",
				"declare const userId: string;",
				"function find() {",
				"  return db.query('SELECT * FROM users WHERE id = ?', [userId]);",
				"}",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});

	it("emits one finding per call site (no double-count via forEachDescendant)", () => {
		const findings = run(
			sqlInterpolation,
			"src/users.ts",
			[
				"declare const db: { query(sql: string): unknown };",
				"declare const userId: string;",
				"declare const role: string;",
				"function find() {",
				"  db.query(`SELECT * FROM users WHERE id = ${userId}`);",
				"  db.query(`UPDATE users SET role = ${role} WHERE id = ${userId}`);",
				"}",
			].join("\n"),
		);
		expect(findings).toHaveLength(2);
		expect(findings[0].line).toBe(5);
		expect(findings[1].line).toBe(6);
	});

	it("flags `sql.unsafe\\`...${x}\\`` tagged template (Prisma-style escape hatch)", () => {
		const findings = run(
			sqlInterpolation,
			"src/users.ts",
			[
				"declare const sql: { unsafe(strings: TemplateStringsArray, ...vals: unknown[]): unknown };",
				"declare const userId: string;",
				"const r = sql.unsafe`SELECT * FROM users WHERE id = ${userId}`;",
			].join("\n"),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].check).toBe("sql_interpolation");
	});

	it("does NOT flag plain `sql\\`...${x}\\`` (Prisma / postgres.js safe parameterising tag)", () => {
		const findings = run(
			sqlInterpolation,
			"src/users.ts",
			[
				"declare function sql(strings: TemplateStringsArray, ...vals: unknown[]): unknown;",
				"declare const userId: string;",
				"const r = sql`SELECT * FROM users WHERE id = ${userId}`;",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});
});

// -------------------------------------------------- csrf_disabled

describe("csrf_disabled", () => {
	it("flags `createBlackhole({ csrf: false })`", () => {
		const findings = run(
			csrfDisabled,
			"src/main.ts",
			[
				"declare function createBlackhole(opts: object): void;",
				"createBlackhole({ csrf: false });",
			].join("\n"),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].check).toBe("csrf_disabled");
	});

	it("does NOT flag default-on blackhole with no `csrf` key", () => {
		const findings = run(
			csrfDisabled,
			"src/main.ts",
			[
				"declare function createBlackhole(opts?: object): void;",
				"createBlackhole({});",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});
});

// -------------------------------------------------- xss_html_raw_output

describe("xss_html_raw_output", () => {
	it("flags `unsafeHtml\\`<div>${x}</div>\\`` tagged template", () => {
		const findings = run(
			xssHtmlRawOutput,
			"src/view.ts",
			[
				"declare function unsafeHtml(strings: TemplateStringsArray, ...vals: unknown[]): string;",
				"declare const userInput: string;",
				"const out = unsafeHtml`<div>${userInput}</div>`;",
			].join("\n"),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].check).toBe("xss_html_raw_output");
	});

	it("does NOT flag `html\\`...\\`` (Lit / lit-html safe-by-default tag)", () => {
		const findings = run(
			xssHtmlRawOutput,
			"src/view.ts",
			[
				"declare function html(strings: TemplateStringsArray, ...vals: unknown[]): string;",
				"declare const userInput: string;",
				"const out = html`<div>${userInput}</div>`;",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});

	it("does NOT flag `escapeHtml(...)` plain calls", () => {
		const findings = run(
			xssHtmlRawOutput,
			"src/view.ts",
			[
				"declare function escapeHtml(s: string): string;",
				"declare const userInput: string;",
				"const out = `<div>${escapeHtml(userInput)}</div>`;",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});
});

// -------------------------------------------------- cookie_missing_flags

describe("cookie_missing_flags", () => {
	it("flags `res.cookie(name, val, { maxAge: 1 })` (all three flags missing)", () => {
		const findings = run(
			cookieMissingFlags,
			"src/api.ts",
			[
				"declare const res: { cookie(name: string, val: string, opts?: object): void };",
				"res.cookie('session', 'tok', { maxAge: 3600 });",
			].join("\n"),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].check).toBe("cookie_missing_flags");
	});

	it("does NOT flag a cookie with all three flags set", () => {
		const findings = run(
			cookieMissingFlags,
			"src/api.ts",
			[
				"declare const res: { cookie(name: string, val: string, opts?: object): void };",
				"res.cookie('session', 'tok', { secure: true, httpOnly: true, sameSite: 'lax' });",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});

	it("does NOT flag a Ream cookie with secure + sameSite (httpOnly defaults true)", () => {
		// `packages/ream/src/http/Response.ts:155` defaults
		// `httpOnly: true` unless explicitly false. Omitting the
		// flag is safe in Ream and must not produce a finding.
		const findings = run(
			cookieMissingFlags,
			"src/api.ts",
			[
				"declare const res: { cookie(name: string, val: string, opts?: object): void };",
				"res.cookie('session', 'tok', { secure: true, sameSite: 'lax' });",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});

	it("flags an explicit `httpOnly: false` downgrade even with secure+sameSite", () => {
		const findings = run(
			cookieMissingFlags,
			"src/api.ts",
			[
				"declare const res: { cookie(name: string, val: string, opts?: object): void };",
				"res.cookie('session', 'tok', { secure: true, sameSite: 'lax', httpOnly: false });",
			].join("\n"),
		);
		expect(findings).toHaveLength(1);
	});

	it("does NOT flag a cookie whose options object contains a spread", () => {
		// Spread may carry the missing flags via runtime resolution
		// — refuse to fire a false-positive.
		const findings = run(
			cookieMissingFlags,
			"src/api.ts",
			[
				"declare const res: { cookie(name: string, val: string, opts?: object): void };",
				"declare const defaults: object;",
				"res.cookie('session', 'tok', { ...defaults, maxAge: 3600 });",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});
});

// -------------------------------------------------- reflect_metadata_missing

describe("reflect_metadata_missing", () => {
	it("flags an entry file lacking the import", () => {
		const findings = run(
			reflectMetadataMissing,
			"src/main.ts",
			["import { bootstrap } from './bootstrap.js';", "bootstrap();"].join(
				"\n",
			),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].check).toBe("reflect_metadata_missing");
		expect(findings[0].line).toBe(1);
	});

	it("does NOT flag when reflect-metadata is imported at the top", () => {
		const findings = run(
			reflectMetadataMissing,
			"src/main.ts",
			[
				'import "reflect-metadata";',
				"import { bootstrap } from './bootstrap.js';",
				"bootstrap();",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});

	it("does NOT flag when entryFile is null (consumer ships its own entry)", () => {
		// `entryFile: null` means the dispatcher could not resolve
		// any of the canonical entry paths — the check must
		// short-circuit rather than fire on every file.
		const findings = run(
			reflectMetadataMissing,
			"src/server.ts",
			["import { x } from './x.js';"].join("\n"),
			null,
		);
		expect(findings).toEqual([]);
	});

	it("does NOT flag a CJS `require('reflect-metadata')` at the top", () => {
		const findings = run(
			reflectMetadataMissing,
			"src/main.ts",
			[
				"const _ = require('reflect-metadata');",
				"const { bootstrap } = require('./bootstrap.js');",
				"bootstrap();",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});
});

// -------------------------------------------------- missing_guard_on_mutation_route

describe("missing_guard_on_mutation_route", () => {
	it("flags `@Post foo()` on a controller with no guard decorator", () => {
		const findings = run(
			missingGuardOnMutationRoute,
			"src/controllers/users.ts",
			[
				"declare const Controller: ClassDecorator;",
				"declare const Post: MethodDecorator;",
				"@Controller",
				"class UsersController {",
				"  @Post",
				"  create() { return null; }",
				"}",
			].join("\n"),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].check).toBe("missing_guard_on_mutation_route");
	});

	it("does NOT flag when class carries `@UseGuards(...)`", () => {
		const findings = run(
			missingGuardOnMutationRoute,
			"src/controllers/users.ts",
			[
				"declare const Controller: ClassDecorator;",
				"declare const Post: MethodDecorator;",
				"declare function UseGuards(...g: unknown[]): ClassDecorator;",
				"declare const AuthGuard: unknown;",
				"@Controller",
				"@UseGuards(AuthGuard)",
				"class UsersController {",
				"  @Post",
				"  create() { return null; }",
				"}",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});
});

// -------------------------------------------------- raw_error_not_reamerror

describe("raw_error_not_reamerror", () => {
	it("flags `throw new Error(...)` inside a controllers/ file", () => {
		const findings = run(
			rawErrorNotReamerror,
			"src/controllers/users.ts",
			[
				"export class UsersController {",
				"  read() {",
				"    throw new Error('not found');",
				"  }",
				"}",
			].join("\n"),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].check).toBe("raw_error_not_reamerror");
		expect(findings[0].line).toBe(3);
	});

	it("does NOT flag `throw new HttpException(...)` inside a controller", () => {
		const findings = run(
			rawErrorNotReamerror,
			"src/controllers/users.ts",
			[
				"declare class HttpException { constructor(msg: string, code: number) }",
				"export class UsersController {",
				"  read() {",
				"    throw new HttpException('not found', 404);",
				"  }",
				"}",
			].join("\n"),
		);
		expect(findings).toEqual([]);
	});

	it("flags a class decorated `@Controller` outside a controllers/ path", () => {
		// Exercises the secondary `isControllerFile` branch that
		// looks at class decorators rather than the file path.
		const findings = run(
			rawErrorNotReamerror,
			"src/api/users.ts",
			[
				"declare const Controller: ClassDecorator;",
				"@Controller",
				"export class UsersApi {",
				"  read() { throw new Error('boom'); }",
				"}",
			].join("\n"),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].check).toBe("raw_error_not_reamerror");
	});
});
