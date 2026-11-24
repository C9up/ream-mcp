/**
 * The NAPI loader (`index.js`) refuses with the package's own coded errors:
 * an unsupported platform, and a binary that cannot be loaded.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.doUnmock("node:process");
	vi.doUnmock("node:module");
	vi.resetModules();
});

/** The suffix napi-rs builds under on this host (the suite runs on built hosts only). */
const TARGETS: Record<string, string> = {
	"linux-x64": "linux-x64-gnu",
	"linux-arm64": "linux-arm64-gnu",
	"darwin-x64": "darwin-x64",
	"darwin-arm64": "darwin-arm64",
	"win32-x64": "win32-x64-msvc",
};
const SUFFIX = TARGETS[`${process.platform}-${process.arch}`] ?? "unsupported";

/** The platform package this host installs. */
const PLATFORM_PACKAGE = `@c9up/ream-mcp-${SUFFIX}`;

/** What `require` throws for a module that is not there. */
function notFound(id: string): Error {
	return Object.assign(new Error(`Cannot find module '${id}'`), {
		code: "MODULE_NOT_FOUND",
	});
}

/** Make the loader's `require` run `load` for every module it asks for. */
function mockRequire(load: (id: string) => unknown): void {
	vi.doMock("node:module", async (importOriginal) => ({
		...(await importOriginal<typeof import("node:module")>()),
		createRequire: () => load,
	}));
}

/** Import the loader afresh and return what it threw. */
async function loadFailure(): Promise<unknown> {
	vi.resetModules();
	try {
		await import("../../index.js");
	} catch (error) {
		return error;
	}
	throw new Error("expected the loader to throw");
}

describe("napi loader", () => {
	it("an unsupported platform is E_REAM_MCP_UNSUPPORTED_PLATFORM, naming the platform", async () => {
		vi.doMock("node:process", async (importOriginal) => ({
			...(await importOriginal<typeof import("node:process")>()),
			platform: "sunos",
			arch: "sparc",
		}));
		const error = await loadFailure();
		// Imported after the reset, so they are the instances the loader used.
		const { Exception } = await import("@c9up/flare");
		const errors = await import("../../src/errors.js");
		expect(error).toBeInstanceOf(Exception);
		expect(error).toBeInstanceOf(errors.E_REAM_MCP_UNSUPPORTED_PLATFORM);
		expect(error).toMatchObject({
			code: "E_REAM_MCP_UNSUPPORTED_PLATFORM",
			message: expect.stringContaining("sunos-sparc"),
		});
	});

	it("a binary that cannot load is E_REAM_MCP_NATIVE_LOAD_FAILED, Node's error as cause and no path in the message", async () => {
		const dlopen = Object.assign(
			new Error("/somewhere/private/index.node: invalid ELF header"),
			{ code: "ERR_DLOPEN_FAILED" },
		);
		vi.doMock("node:module", async (importOriginal) => ({
			...(await importOriginal<typeof import("node:module")>()),
			createRequire: () => () => {
				throw dlopen;
			},
		}));
		const error = await loadFailure();
		const errors = await import("../../src/errors.js");
		expect(error).toBeInstanceOf(errors.E_REAM_MCP_NATIVE_LOAD_FAILED);
		expect(error).toMatchObject({
			code: "E_REAM_MCP_NATIVE_LOAD_FAILED",
			message: expect.stringContaining("ERR_DLOPEN_FAILED"),
			cause: dlopen,
		});
		expect(error).not.toHaveProperty(
			"message",
			expect.stringContaining("/somewhere"),
		);
	});

	it("a local binary that fails to load says to rebuild it, never falling back to the platform package", async () => {
		const asked: string[] = [];
		vi.doMock("node:module", async (importOriginal) => ({
			...(await importOriginal<typeof import("node:module")>()),
			createRequire: () => (id: string) => {
				asked.push(id);
				throw Object.assign(new Error("invalid ELF header"), {
					code: "ERR_DLOPEN_FAILED",
				});
			},
		}));
		const error = await loadFailure();
		expect(asked).toHaveLength(1);
		expect(error).toHaveProperty(
			"message",
			expect.stringContaining(
				`Fix: index.${SUFFIX}.node failed to load. Rebuild it: cd packages/ream-mcp && pnpm build:napi`,
			),
		);
	});

	it("loads the platform package when no local binary is built", async () => {
		const asked: string[] = [];
		mockRequire((id) => {
			asked.push(id);
			if (id === PLATFORM_PACKAGE) return { version: () => "from-package" };
			throw notFound(id);
		});
		vi.resetModules();
		const { core } = await import("../../index.js");
		expect(core.version()).toBe("from-package");
		expect(asked).toHaveLength(2);
		expect(asked[0]).toMatch(new RegExp(`[\\\\/]index\\.${SUFFIX}\\.node$`));
		expect(asked[1]).toBe(PLATFORM_PACKAGE);
	});

	it("prefers the local build, and never asks for the package then", async () => {
		const asked: string[] = [];
		mockRequire((id) => {
			asked.push(id);
			return { version: () => "local" };
		});
		vi.resetModules();
		const { core } = await import("../../index.js");
		expect(core.version()).toBe("local");
		expect(asked).toHaveLength(1);
	});

	it("names the platform package to install when neither is there, the load error as cause", async () => {
		mockRequire((id) => {
			throw notFound(id);
		});
		const error = await loadFailure();
		const errors = await import("../../src/errors.js");
		expect(error).toBeInstanceOf(errors.E_REAM_MCP_NATIVE_LOAD_FAILED);
		expect(error).toMatchObject({
			message: expect.stringContaining(
				`cannot load the native binary '${PLATFORM_PACKAGE}' (MODULE_NOT_FOUND)`,
			),
			cause: { code: "MODULE_NOT_FOUND" },
		});
		expect(error).toHaveProperty(
			"message",
			expect.stringContaining(
				`Fix: install ${PLATFORM_PACKAGE} at the exact version of @c9up/ream-mcp`,
			),
		);
		expect(error).not.toHaveProperty(
			"message",
			expect.stringContaining("Cannot find module"),
		);
	});

	it("loads the built binary on a supported platform", async () => {
		vi.resetModules();
		const { core } = await import("../../index.js");
		expect(typeof core.version()).toBe("string");
	});
});
