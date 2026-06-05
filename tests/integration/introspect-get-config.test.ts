import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { dispatchIntrospect } from "../../src/tools/introspect.js";
import { _resetCache } from "../../src/util/ts-static-parser.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "introspect-app");

beforeAll(() => {
	_resetCache();
});

describe("introspect > get.config (no key)", () => {
	it("returns parsed tree with env refs and unevaluated entries", () => {
		const result = dispatchIntrospect(FIXTURE, "get.config") as {
			config: {
				app: {
					name: string;
					port: { env: string; default: unknown };
					logLevel: { env: string; default: unknown };
					debug: boolean;
					tags: string[];
					plugins: unknown[];
				};
				database: {
					default: string;
					connections: { pg: { user: { env: string } } };
				};
			};
		};
		expect(result.config.app.name).toBe("introspect-fixture");
		expect(result.config.app.debug).toBe(false);
		expect(result.config.app.tags).toEqual(["alpha", "beta"]);

		// process.env.PORT — surfaced as { env, default }
		expect(result.config.app.port).toMatchObject({
			env: "PORT",
			default: null,
		});
		// env('LOG_LEVEL', 'info') — default resolved
		expect(result.config.app.logLevel).toMatchObject({
			env: "LOG_LEVEL",
			default: "info",
		});

		// Imported ref inside an array — first element is unevaluated.
		const firstPlugin = result.config.app.plugins[0] as {
			unevaluated: true;
			expression: string;
		};
		expect(firstPlugin.unevaluated).toBe(true);
		expect(firstPlugin.expression).toBe("LoggingMiddleware");

		// Nested config from a different file.
		expect(result.config.database.default).toBe("pg");
		expect(result.config.database.connections.pg.user).toMatchObject({
			env: "DB_USER",
		});
	});
});

describe("introspect > get.config (with key)", () => {
	it("descends a dotted path", () => {
		const result = dispatchIntrospect(FIXTURE, "get.config", {
			key: "app.name",
		}) as {
			config: { "app.name": string };
		};
		expect(result.config["app.name"]).toBe("introspect-fixture");
	});

	it("returns sibling-keys hint on miss", () => {
		const result = dispatchIntrospect(FIXTURE, "get.config", {
			key: "app.unknownKey",
		}) as { error: string; hint: string };
		expect(result.error).toContain("not found");
		expect(result.hint).toContain("name");
		expect(result.hint).toContain("port");
	});

	it("refuses to descend into an unevaluated node", () => {
		const result = dispatchIntrospect(FIXTURE, "get.config", {
			key: "app.plugins.foo",
		}) as { error: string; hint: string };
		// `plugins` itself IS an array (not unevaluated). Descending
		// into a string seg of an array hits the "non-object" branch.
		expect(result.error).toContain("cannot descend");
	});
});

describe("introspect > error paths", () => {
	it("returns structured error when no app/ or src/ folder exists", () => {
		// `/tmp/no-such-dir` has neither — this is the spec-required
		// error path (AC: missing source folder).
		const result = dispatchIntrospect("/tmp/no-such-dir", "list.routes") as {
			error: string;
			hint: string;
			knownGaps: string[];
		};
		expect(result.error).toBe("expected app/ or src/ directory");
		expect(result.hint).toContain("/tmp/no-such-dir");
		// Spec contract: every error response includes `knownGaps`.
		expect(result.knownGaps).toEqual([]);
	});

	it("returns structured error when app/ exists but tsconfig missing", () => {
		// Build a tmp dir with just an `app/` folder so we hit the
		// tsconfig-not-found branch, not the source-folder branch.
		const tmpRoot = mkdtempSync(join(tmpdir(), "introspect-no-tsconfig-"));
		mkdirSync(join(tmpRoot, "app"));
		try {
			const result = dispatchIntrospect(tmpRoot, "list.routes") as {
				error: string;
				hint: string;
				knownGaps: string[];
			};
			expect(result.error).toBe("tsconfig.json not found");
			expect(result.knownGaps).toEqual([]);
		} finally {
			rmSync(tmpRoot, { recursive: true, force: true });
		}
	});
});
