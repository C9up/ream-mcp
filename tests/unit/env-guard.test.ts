/**
 * `env-guard` unit tests — Story 33.6.
 *
 * Covers the env-detection priority + the consent gate
 * (dry-run bypass, missing-confirm refusal, production
 * single-flag refusal, production double-flag pass).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkConsent, detectEnv } from "../../src/util/env-guard.js";

const SAVED_REAM_ENV = process.env.REAM_ENV;
const SAVED_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
	delete process.env.REAM_ENV;
	delete process.env.NODE_ENV;
});

afterEach(() => {
	if (SAVED_REAM_ENV === undefined) delete process.env.REAM_ENV;
	else process.env.REAM_ENV = SAVED_REAM_ENV;
	if (SAVED_NODE_ENV === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = SAVED_NODE_ENV;
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

	it("uses the override when both env vars are unset", () => {
		expect(detectEnv("staging")).toBe("staging");
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
		// Guard against `NODE_ENV=Production` slipping past the
		// production double-flag check in `checkConsent`.
		process.env.NODE_ENV = "Production";
		expect(detectEnv()).toBe("production");
		delete process.env.NODE_ENV;
		process.env.REAM_ENV = "PROD";
		expect(detectEnv()).toBe("prod");
	});
});

describe("checkConsent", () => {
	it("passes through when dryRun is true (no DB mutation)", () => {
		expect(
			checkConsent({
				dryRun: true,
				confirm: false,
				allowProduction: false,
			}),
		).toBeNull();
	});

	it("refuses when dryRun is false and confirm is missing", () => {
		const refusal = checkConsent({
			dryRun: false,
			confirm: false,
			allowProduction: false,
		});
		expect(refusal).not.toBeNull();
		expect(refusal?.error).toContain("confirm: true required");
	});

	it("refuses production with confirm: true but no allowProduction", () => {
		process.env.NODE_ENV = "production";
		const refusal = checkConsent({
			dryRun: false,
			confirm: true,
			allowProduction: false,
		});
		expect(refusal).not.toBeNull();
		expect(refusal?.error).toContain("production");
		expect(refusal?.error).toContain("allowProduction");
	});

	it("passes production with both confirm AND allowProduction", () => {
		process.env.NODE_ENV = "production";
		expect(
			checkConsent({
				dryRun: false,
				confirm: true,
				allowProduction: true,
			}),
		).toBeNull();
	});

	it("respects the env override on the consent path", () => {
		process.env.NODE_ENV = "development";
		const refusal = checkConsent({
			dryRun: false,
			confirm: true,
			allowProduction: false,
			env: "production",
		});
		// `env` is the LOWEST priority — REAM_ENV/NODE_ENV win — so
		// when NODE_ENV is "development" the override is ignored.
		expect(refusal).toBeNull();
	});

	it("uses env override when no env vars are set", () => {
		const refusal = checkConsent({
			dryRun: false,
			confirm: true,
			allowProduction: false,
			env: "production",
		});
		expect(refusal).not.toBeNull();
		expect(refusal?.error).toContain("production");
	});
});
