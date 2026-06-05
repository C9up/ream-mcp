import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import {
	evaluateLiteral,
	extractEnvRef,
	findCallExpressions,
	findClassesByDecorator,
	findSymbol,
	isEnvRef,
	isPlainRecord,
	isUnevaluated,
} from "../../src/util/ts-static-parser.js";

function projectFromSource(source: string): Project {
	const project = new Project({ useInMemoryFileSystem: true });
	project.createSourceFile("/virtual/x.ts", source);
	return project;
}

describe("evaluateLiteral", () => {
	it("returns primitives verbatim", () => {
		const project = projectFromSource(`
			export const a = "hello";
			export const b = 42;
			export const c = true;
			export const d = null;
		`);
		const sf = project.getSourceFileOrThrow("/virtual/x.ts");
		const get = (name: string) =>
			sf.getVariableDeclarationOrThrow(name).getInitializerOrThrow();
		expect(evaluateLiteral(get("a"))).toBe("hello");
		expect(evaluateLiteral(get("b"))).toBe(42);
		expect(evaluateLiteral(get("c"))).toBe(true);
		expect(evaluateLiteral(get("d"))).toBeNull();
	});

	it("evaluates nested object + array literals", () => {
		const project = projectFromSource(`
			export const cfg = {
				name: "x",
				flags: [true, false],
				nested: { count: 3 },
			};
		`);
		const sf = project.getSourceFileOrThrow("/virtual/x.ts");
		const init = sf
			.getVariableDeclarationOrThrow("cfg")
			.getInitializerOrThrow();
		const value = evaluateLiteral(init);
		expect(value).toEqual({
			name: "x",
			flags: [true, false],
			nested: { count: 3 },
		});
	});

	it("surfaces unevaluated nodes", () => {
		const project = projectFromSource(`
			declare function fn(): unknown;
			export const v = fn();
		`);
		const sf = project.getSourceFileOrThrow("/virtual/x.ts");
		const init = sf.getVariableDeclarationOrThrow("v").getInitializerOrThrow();
		const result = evaluateLiteral(init);
		expect(isUnevaluated(result)).toBe(true);
		if (isUnevaluated(result)) {
			expect(result.expression).toBe("fn()");
		}
	});

	it("handles negative numeric literals", () => {
		const project = projectFromSource(`export const n = -7;`);
		const sf = project.getSourceFileOrThrow("/virtual/x.ts");
		const init = sf.getVariableDeclarationOrThrow("n").getInitializerOrThrow();
		expect(evaluateLiteral(init)).toBe(-7);
	});

	it("resolves identifiers pointing at literals in same file", () => {
		const project = projectFromSource(`
			const constant = "resolved";
			export const ref = constant;
		`);
		const sf = project.getSourceFileOrThrow("/virtual/x.ts");
		const init = sf
			.getVariableDeclarationOrThrow("ref")
			.getInitializerOrThrow();
		expect(evaluateLiteral(init)).toBe("resolved");
	});
});

describe("extractEnvRef", () => {
	it("recognizes process.env.X", () => {
		const project = projectFromSource(`export const v = process.env.PORT;`);
		const sf = project.getSourceFileOrThrow("/virtual/x.ts");
		const init = sf.getVariableDeclarationOrThrow("v").getInitializerOrThrow();
		expect(extractEnvRef(init)).toEqual({ env: "PORT", default: null });
	});

	it("recognizes env('X', default)", () => {
		const project = projectFromSource(
			`export const v = env("LOG_LEVEL", "info");`,
		);
		const sf = project.getSourceFileOrThrow("/virtual/x.ts");
		const init = sf.getVariableDeclarationOrThrow("v").getInitializerOrThrow();
		expect(extractEnvRef(init)).toEqual({ env: "LOG_LEVEL", default: "info" });
	});

	it("returns null on unrelated calls", () => {
		const project = projectFromSource(`export const v = other("X");`);
		const sf = project.getSourceFileOrThrow("/virtual/x.ts");
		const init = sf.getVariableDeclarationOrThrow("v").getInitializerOrThrow();
		expect(extractEnvRef(init)).toBeNull();
	});
});

describe("findClassesByDecorator", () => {
	it("matches by leaf decorator name", () => {
		const project = projectFromSource(`
			@Entity("foo") export class A {}
			@Entity export class B {}
			@Other export class C {}
		`);
		const found = findClassesByDecorator(project, "Entity");
		expect(found.map((f) => f.decl.getName()).sort()).toEqual(["A", "B"]);
	});
});

describe("findCallExpressions", () => {
	it("matches call sites by leaf identifier", () => {
		const project = projectFromSource(`
			bus.subscribe("a", () => {});
			this.bus.subscribe("b", () => {});
			emitter.subscribe("c", () => {});
			otherFn();
		`);
		const sites = findCallExpressions(project, (leaf) => leaf === "subscribe");
		expect(sites.length).toBe(3);
	});
});

describe("findSymbol", () => {
	it("finds a class by name", () => {
		const project = projectFromSource(`
			export class MyClass {
				method() {}
			}
		`);
		const site = findSymbol(project, "MyClass");
		expect(site?.kind).toBe("class");
		expect(site?.name).toBe("MyClass");
		expect(site?.signature).toContain("class MyClass");
	});

	it("finds a function declaration", () => {
		const project = projectFromSource(
			`export function helper(x: number) { return x; }`,
		);
		const site = findSymbol(project, "helper");
		expect(site?.kind).toBe("function");
	});

	it("returns null for unknown symbols", () => {
		const project = projectFromSource(`export const x = 1;`);
		expect(findSymbol(project, "NoSuch")).toBeNull();
	});
});

describe("type guards", () => {
	it("isPlainRecord rejects unevaluated and env refs", () => {
		expect(isPlainRecord({ a: 1 })).toBe(true);
		expect(isPlainRecord({ unevaluated: true, expression: "x" })).toBe(false);
		expect(isPlainRecord({ env: "X", default: null })).toBe(false);
		expect(isPlainRecord([])).toBe(false);
		expect(isPlainRecord("str")).toBe(false);
		expect(isPlainRecord(null)).toBe(false);
	});

	it("isUnevaluated narrows correctly", () => {
		expect(isUnevaluated({ unevaluated: true, expression: "x" })).toBe(true);
		expect(isUnevaluated({ a: 1 })).toBe(false);
		expect(isUnevaluated("str")).toBe(false);
	});

	it("isEnvRef requires the strict 2-key shape (M8 patch)", () => {
		// Real env refs.
		expect(isEnvRef({ env: "PORT", default: null })).toBe(true);
		expect(isEnvRef({ env: "PORT", default: "8080" })).toBe(true);
		// User config that happens to have an `env` key but isn't a
		// runtime ref — must NOT be classified as EnvRef.
		expect(isEnvRef({ env: "production", port: 3000 })).toBe(false);
		expect(isEnvRef({ env: "production" })).toBe(false);
		expect(isEnvRef("env")).toBe(false);
	});

	it("isPlainRecord accepts a config object whose env key is a plain string", () => {
		// M8 — { env: 'production', port: 3000 } must be walkable.
		expect(isPlainRecord({ env: "production", port: 3000 })).toBe(true);
	});
});

describe("evaluateLiteral — recursion guard (H6 patch)", () => {
	it("does not stack-overflow on self-referential variable", () => {
		const project = projectFromSource(`const x = x;\nexport const ref = x;`);
		const sf = project.getSourceFileOrThrow("/virtual/x.ts");
		const init = sf
			.getVariableDeclarationOrThrow("ref")
			.getInitializerOrThrow();
		// Should return unevaluated, not throw RangeError.
		const result = evaluateLiteral(init);
		expect(isUnevaluated(result)).toBe(true);
	});
});

describe("evaluateLiteral — property access on as const (M2 patch)", () => {
	it("resolves EVENT_NAMES.UserRegistered against same-file as const", () => {
		const project = projectFromSource(`
			const EVENT_NAMES = {
				UserRegistered: "user.registered",
				UserDeleted: "user.deleted",
			} as const;
			export const ref = EVENT_NAMES.UserRegistered;
		`);
		const sf = project.getSourceFileOrThrow("/virtual/x.ts");
		const init = sf
			.getVariableDeclarationOrThrow("ref")
			.getInitializerOrThrow();
		expect(evaluateLiteral(init)).toBe("user.registered");
	});
});

describe("findSymbol — non-test path preference (M7 patch)", () => {
	it("prefers a production path when same name exists in tests/", () => {
		const project = new Project({ useInMemoryFileSystem: true });
		project.createSourceFile("/virtual/app/User.ts", "export class User {}");
		project.createSourceFile(
			"/virtual/tests/fixtures/User.ts",
			"export class User {}",
		);
		const site = findSymbol(project, "User");
		expect(site?.file).toContain("/app/User.ts");
		expect(site?.ambiguous).toBeUndefined();
	});

	it("flags ambiguity when two production paths both match", () => {
		const project = new Project({ useInMemoryFileSystem: true });
		project.createSourceFile("/virtual/a/User.ts", "export class User {}");
		project.createSourceFile("/virtual/b/User.ts", "export class User {}");
		const site = findSymbol(project, "User");
		expect(site?.ambiguous).toBe(true);
	});
});
