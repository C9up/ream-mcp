/**
 * `env-guard` unit tests: env detection, the confirm accident guard, the
 * launch-time write gate and the local/production target classification.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	authorizeWrite,
	checkConsent,
	classifyTarget,
	detectEnv,
} from "../../src/util/env-guard.js";

const VARS = [
	"REAM_ENV",
	"NODE_ENV",
	"REAM_MCP_ALLOW_MIGRATIONS",
	"REAM_MCP_ALLOW_PRODUCTION_MIGRATIONS",
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
	for (const v of VARS) {
		saved.set(v, process.env[v]);
		delete process.env[v];
	}
});

afterEach(() => {
	for (const v of VARS) {
		const value = saved.get(v);
		if (value === undefined) delete process.env[v];
		else process.env[v] = value;
	}
});

describe("detectEnv", () => {
	it("prefers REAM_ENV over NODE_ENV", () => {
		process.env.REAM_ENV = "production";
		process.env.NODE_ENV = "development";
		expect(detectEnv()).toBe("production");
	});

	it("falls back to NODE_ENV when REAM_ENV is unset", () => {
		process.env.NODE_ENV = "test";
		expect(detectEnv()).toBe("test");
	});

	it("returns 'development' when nothing is set", () => {
		expect(detectEnv()).toBe("development");
	});

	it("ignores empty-string env values", () => {
		process.env.REAM_ENV = "";
		process.env.NODE_ENV = "production";
		expect(detectEnv()).toBe("production");
	});

	it("normalizes mixed-case env values to lowercase", () => {
		process.env.NODE_ENV = "Production";
		expect(detectEnv()).toBe("production");
	});
});

describe("checkConsent", () => {
	it("lets a preview through without confirm", () => {
		expect(checkConsent({ dryRun: true, confirm: false })).toBeNull();
	});

	it("refuses a write without confirm", () => {
		expect(checkConsent({ dryRun: false, confirm: false })?.error).toBe(
			"confirm: true required",
		);
	});
});

const LOCAL = { local: true, description: "a local database server" };
const REMOTE = {
	local: false,
	description: "a database host that is not loopback",
};

describe("authorizeWrite", () => {
	it("refuses everything when writes were not enabled at launch", () => {
		const r = authorizeWrite(LOCAL);
		expect(r.ok).toBe(false);
	});

	it("only counts 1 / true as enabling", () => {
		process.env.REAM_MCP_ALLOW_MIGRATIONS = "yes";
		expect(authorizeWrite(LOCAL).ok).toBe(false);
		process.env.REAM_MCP_ALLOW_MIGRATIONS = "TRUE";
		expect(authorizeWrite(LOCAL)).toEqual({ ok: true, production: false });
	});

	it("treats a non-local target as production with NODE_ENV unset", () => {
		process.env.REAM_MCP_ALLOW_MIGRATIONS = "1";
		const refused = authorizeWrite(REMOTE);
		expect(refused.ok).toBe(false);
		process.env.REAM_MCP_ALLOW_PRODUCTION_MIGRATIONS = "1";
		expect(authorizeWrite(REMOTE)).toEqual({ ok: true, production: true });
	});

	it("treats REAM_ENV=production as production even for a local target", () => {
		process.env.REAM_MCP_ALLOW_MIGRATIONS = "1";
		process.env.REAM_ENV = "production";
		expect(authorizeWrite(LOCAL).ok).toBe(false);
		process.env.REAM_MCP_ALLOW_PRODUCTION_MIGRATIONS = "1";
		expect(authorizeWrite(LOCAL)).toEqual({ ok: true, production: true });
	});

	it("does not accept the production flag alone", () => {
		process.env.REAM_MCP_ALLOW_PRODUCTION_MIGRATIONS = "1";
		expect(authorizeWrite(REMOTE).ok).toBe(false);
	});
});

describe("classifyTarget", () => {
	let base: string;
	let project: string;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "env-guard-"));
		project = join(base, "project");
		mkdirSync(project);
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	it.each([
		"postgres://u:p@localhost:5432/app",
		"postgresql://u:p@127.0.0.1/app",
		"postgres://u:p@127.8.9.10/app",
		"mysql://u:p@[::1]:3306/app",
		"postgres:///app",
		"postgres://u@db.example.com/app?host=/var/run/postgresql",
		"mysql://u:p@localhost/app?socket=/tmp/mysql.sock",
	])("%s is local", (url) => {
		expect(classifyTarget(url, project).local).toBe(true);
	});

	it.each([
		"postgres://u:p@db.example.com/app",
		"postgres://u:p@10.0.0.5/app",
		"postgres://u@localhost/app?host=db.example.com",
		"mysql://u:p@localhost.example.com/app",
		"oracle://u:p@localhost/app",
		"postgres://%%%",
		"not a url",
	])("%s is not local", (url) => {
		expect(classifyTarget(url, project).local).toBe(false);
	});

	it("never echoes the URL in its description", () => {
		const t = classifyTarget("postgres://app:S3cret@db.internal/app", project);
		expect(t.description).not.toContain("S3cret");
		expect(t.description).not.toContain("db.internal");
	});

	it("classifies sqlite files by where they really land", () => {
		const outside = join(base, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(project, "data"), "dir");
		expect(classifyTarget("sqlite::memory:", project).local).toBe(true);
		expect(
			classifyTarget("sqlite:file:x?mode=memory&cache=shared", project).local,
		).toBe(true);
		expect(
			classifyTarget(`sqlite://${join(project, "tmp", "db.sqlite")}`, project)
				.local,
		).toBe(true);
		expect(
			classifyTarget("sqlite://tmp/db.sqlite?mode=rwc", project, project).local,
		).toBe(true);
		expect(
			classifyTarget("sqlite://../outside/db.sqlite", project, project).local,
		).toBe(false);
		expect(
			classifyTarget(`sqlite://${join(outside, "db.sqlite")}`, project).local,
		).toBe(false);
		expect(
			classifyTarget(`sqlite://${join(project, "data", "db.sqlite")}`, project)
				.local,
		).toBe(false);
		expect(
			classifyTarget("sqlite://%2e%2e/outside/db.sqlite", project, project)
				.local,
		).toBe(false);
	});
});
