import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { dispatchIntrospect } from "../../src/tools/introspect.js";
import { _resetCache } from "../../src/util/ts-static-parser.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "introspect-app");

interface CommonShape {
	confidence: "high" | "medium" | "low";
	knownGaps: string[];
}

beforeAll(() => {
	_resetCache();
});

describe("introspect > list.routes", () => {
	it("flattens groups and merges middleware/prefix", () => {
		const result = dispatchIntrospect(FIXTURE, "list.routes") as CommonShape & {
			routes: Array<{
				method: string;
				path: string;
				controller: string | null;
				action: string;
				middleware: string[];
				guards: string[];
				file: string;
				line: number;
			}>;
		};
		expect(result.confidence).toBe("high");
		expect(result.routes.length).toBe(5);

		const health = result.routes.find((r) => r.path === "/health");
		expect(health).toBeDefined();
		expect(health?.method).toBe("GET");
		expect(health?.middleware).toEqual([]);

		const usersIndex = result.routes.find(
			(r) => r.path === "/api/users" && r.method === "GET",
		);
		expect(usersIndex).toBeDefined();
		expect(usersIndex?.controller).toBe("UsersController");
		expect(usersIndex?.action).toBe("index");
		expect(usersIndex?.middleware).toEqual(["auth"]);

		// Output is sorted by (method, path).
		const sorted = [...result.routes].sort((a, b) =>
			a.method === b.method
				? a.path.localeCompare(b.path)
				: a.method.localeCompare(b.method),
		);
		expect(result.routes).toEqual(sorted);
	});

	it("flattens NESTED groups: outer + inner prefix and middleware compose", () => {
		// Patch H1: outer `/api` + inner `/v2` → `/api/v2/admin`,
		// outer `auth` + inner `throttle` → both prepended in
		// outer→inner order.
		const result = dispatchIntrospect(FIXTURE, "list.routes") as {
			routes: Array<{
				method: string;
				path: string;
				middleware: string[];
			}>;
		};
		const admin = result.routes.find((r) => r.path === "/api/v2/admin");
		expect(admin).toBeDefined();
		expect(admin?.method).toBe("GET");
		expect(admin?.middleware).toEqual(["auth", "throttle"]);
	});
});

describe("introspect > list.entities", () => {
	it("returns @Entity classes with columns, relations, hooks", () => {
		const result = dispatchIntrospect(
			FIXTURE,
			"list.entities",
		) as CommonShape & {
			entities: Array<{
				name: string;
				table: string | null;
				columns: { name: string; type: string | null }[];
				relations: { name: string; kind: string; target: string }[];
				hooks: { name: string; method: string }[];
			}>;
		};
		expect(result.entities.length).toBe(2);

		const user = result.entities.find((e) => e.name === "User");
		expect(user?.table).toBe("users");
		expect(user?.columns.map((c) => c.name).sort()).toEqual(["email", "id"]);
		expect(user?.relations[0]?.kind).toBe("HasMany");
		expect(user?.relations[0]?.target).toBe("Post");
		expect(user?.hooks[0]).toMatchObject({
			name: "BeforeSave",
			method: "hashPasswordOnSave",
		});

		const post = result.entities.find((e) => e.name === "Post");
		// Patch H2: `@Entity({ table: 'posts' })` (object form)
		// resolves to the literal — was returning null before fix.
		expect(post?.table).toBe("posts");
		expect(post?.relations[0]?.kind).toBe("BelongsTo");
		expect(post?.hooks[0]?.name).toBe("AfterCreate");
	});
});

describe("introspect > list.events", () => {
	it("groups subscribers and emitters by event name", () => {
		const result = dispatchIntrospect(FIXTURE, "list.events") as CommonShape & {
			events: Array<{
				event: string | null;
				subscribers: { file: string; line: number; target: string | null }[];
				emitters: { file: string; line: number; expression?: string }[];
			}>;
		};

		const userRegistered = result.events.find(
			(e) => e.event === "user.registered",
		);
		expect(userRegistered).toBeDefined();
		// @EventListener("user.registered") subscriber
		expect(
			userRegistered?.subscribers.find(
				(s) => s.target === "WelcomeEmailListener",
			),
		).toBeDefined();
		// bus.emit(new UserRegistered(...)) — resolved via static EVENT_NAME
		expect(userRegistered?.emitters.length).toBeGreaterThanOrEqual(1);

		// bus.subscribe('user.deleted', ...) inline
		const userDeleted = result.events.find((e) => e.event === "user.deleted");
		expect(userDeleted?.subscribers.length).toBe(1);
		expect(userDeleted?.subscribers[0]?.target).toBeNull();

		// bus.dispatch('user.goodbye', ...) literal
		const goodbye = result.events.find((e) => e.event === "user.goodbye");
		expect(goodbye?.emitters.length).toBe(1);
	});
});

describe("introspect > list.providers", () => {
	it("returns *Provider classes with lifecycle and bindings", () => {
		const result = dispatchIntrospect(
			FIXTURE,
			"list.providers",
		) as CommonShape & {
			providers: Array<{
				name: string;
				lifecycle: {
					register: number | null;
					boot: number | null;
					shutdown: number | null;
				};
				bindings: { kind: string; token: unknown }[];
			}>;
		};
		expect(result.providers.length).toBe(2);

		const app = result.providers.find((p) => p.name === "AppProvider");
		expect(app?.lifecycle.register).not.toBeNull();
		expect(app?.lifecycle.boot).toBeNull();
		expect(app?.bindings.length).toBe(1);
		expect(app?.bindings[0]?.token).toBe("logger");
		expect(app?.bindings[0]?.kind).toBe("bind");

		const mail = result.providers.find((p) => p.name === "MailProvider");
		expect(mail?.lifecycle.boot).not.toBeNull();
		expect(mail?.lifecycle.shutdown).not.toBeNull();
		expect(mail?.bindings[0]?.kind).toBe("singleton");
		expect(mail?.bindings[0]?.token).toBe("mailer");
	});
});

describe("introspect > list.middleware", () => {
	it("returns global + named middleware preserving array order", () => {
		const result = dispatchIntrospect(
			FIXTURE,
			"list.middleware",
		) as CommonShape & {
			middleware: Array<{
				name: string;
				kind: "global" | "named";
				ref: string;
			}>;
		};
		const globals = result.middleware.filter((m) => m.kind === "global");
		expect(globals.map((g) => g.name)).toEqual([
			"LoggingMiddleware",
			"CorsMiddleware",
			"BodyParserMiddleware",
		]);
		const named = result.middleware.filter((m) => m.kind === "named");
		expect(named.map((n) => n.name).sort()).toEqual(["auth", "throttle"]);
	});
});
