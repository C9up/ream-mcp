/**
 * `doctor.env_check` integration test — Story 33.8.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchDoctor } from "../../src/tools/doctor.js";

const SAVED_REAM_ENV = process.env.REAM_ENV;

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "doctor-env-"));
	delete process.env.REAM_ENV;
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
	if (SAVED_REAM_ENV === undefined) delete process.env.REAM_ENV;
	else process.env.REAM_ENV = SAVED_REAM_ENV;
});

interface EnvCheckShape {
	envVars: Array<{
		name: string;
		set: boolean;
		sensitive: boolean;
		hint: string;
	}>;
	configFiles: Array<{ path: string; exists: boolean; hint: string }>;
	confidence: string;
	knownGaps: string[];
}

describe("doctor.env_check", () => {
	it("reports `REAM_ENV: set: false` when the env var is unset", async () => {
		const result = (await dispatchDoctor(
			scratch,
			"doctor.env_check",
			{},
		)) as EnvCheckShape;
		const reamEnv = result.envVars.find((e) => e.name === "REAM_ENV");
		expect(reamEnv?.set).toBe(false);
	});

	it("reports `REAM_ENV: set: true` after the env var is set", async () => {
		process.env.REAM_ENV = "development";
		const result = (await dispatchDoctor(
			scratch,
			"doctor.env_check",
			{},
		)) as EnvCheckShape;
		const reamEnv = result.envVars.find((e) => e.name === "REAM_ENV");
		expect(reamEnv?.set).toBe(true);
		// Sensitive flag false for env-name vars; sensitive vars are
		// the database-URL / token kind.
		expect(reamEnv?.sensitive).toBe(false);
	});

	it("never echoes sensitive values — only the `set: bool` flag", async () => {
		process.env.DATABASE_URL = "postgres://user:password@host/db";
		try {
			const result = (await dispatchDoctor(
				scratch,
				"doctor.env_check",
				{},
			)) as EnvCheckShape;
			const dbUrl = result.envVars.find((e) => e.name === "DATABASE_URL");
			expect(dbUrl?.set).toBe(true);
			expect(dbUrl?.sensitive).toBe(true);
			// Critical: the secret must NOT leak into any field.
			const wireShape = JSON.stringify(result);
			expect(wireShape).not.toContain("password");
			expect(wireShape).not.toContain("postgres://");
		} finally {
			delete process.env.DATABASE_URL;
		}
	});

	it("flags `package.json` exists when the file is present", async () => {
		writeFileSync(
			join(scratch, "package.json"),
			JSON.stringify({ name: "scratch", version: "0.0.0" }),
		);
		const result = (await dispatchDoctor(
			scratch,
			"doctor.env_check",
			{},
		)) as EnvCheckShape;
		const pkg = result.configFiles.find((c) => c.path === "package.json");
		expect(pkg?.exists).toBe(true);
	});
});
