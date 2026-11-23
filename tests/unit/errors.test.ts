import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Exception } from "@c9up/flare";
import { afterAll, describe, expect, it } from "vitest";

import * as errors from "../../src/errors.js";
import { core } from "../../src/native/core.js";

describe("errors", () => {
	it("@c9up/ream-mcp/errors exports the errors, each a flare Exception", async () => {
		const self = await import("@c9up/ream-mcp/errors");
		expect(self.E_REAM_MCP_INVALID_MIGRATION).toBe(
			errors.E_REAM_MCP_INVALID_MIGRATION,
		);
		const error = new errors.E_REAM_MCP_INVALID_MIGRATION([
			"0001_users.ts",
			"the default export is not a migration class",
		]);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toBeInstanceOf(errors.E_REAM_MCP_INVALID_MIGRATION);
		expect(error).toMatchObject({
			code: "E_REAM_MCP_INVALID_MIGRATION",
			status: 500,
			message: "0001_users.ts: the default export is not a migration class",
		});
	});
});

describe("errors > the native core", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ream-mcp-errors-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("a JSON the binding cannot read is E_REAM_MCP_INVALID_JSON, the native error as cause", () => {
		let caught: unknown;
		try {
			core.search(dir, "query", "{not json");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(errors.E_REAM_MCP_INVALID_JSON);
		expect(caught).toMatchObject({ code: "E_REAM_MCP_INVALID_JSON" });
		expect(caught).toHaveProperty("cause", expect.any(Error));
	});

	it("an index the binding cannot open is E_REAM_MCP_INDEX_FAILED", async () => {
		// A file where the project root should be: the store cannot be created under it.
		const notADirectory = path.join(dir, "file");
		writeFileSync(notADirectory, "");
		await expect(core.indexCorpus(notADirectory, false)).rejects.toMatchObject({
			code: "E_REAM_MCP_INDEX_FAILED",
			cause: expect.any(Error),
		});
	});
});
