import { describe, expect, it } from "vitest";

import { redactPaths, redactUrl } from "../../src/util/redact.js";

describe("redactUrl", () => {
	it("removes the whole URL and the password, encoded or not", () => {
		const url = "postgres://app:p%40ss%2Fw0rd@db.internal:5432/app";
		const detail = `connect ${url} failed; auth for p%40ss%2Fw0rd / p@ss/w0rd refused`;
		const out = redactUrl(detail, url);
		expect(out).not.toContain("p%40ss%2Fw0rd");
		expect(out).not.toContain("p@ss/w0rd");
		expect(out).not.toContain("db.internal");
		expect(out).toContain("<database-url>");
	});

	it("leaves text alone when the URL has no password", () => {
		expect(redactUrl("timeout", "sqlite://app.db")).toBe("timeout");
	});
});

describe("redactPaths", () => {
	it("scrubs POSIX and Windows absolute paths", () => {
		expect(
			redactPaths("ENOENT: open '/home/u/app/x.ts' and C:\\Users\\u\\x.ts"),
		).toBe("ENOENT: open '<path>' and <path>");
	});
});
