/**
 * `security.scan` integration tests — Story 33.7.
 *
 * Drives the dispatcher end-to-end against on-disk fixtures
 * (`security-clean` and `security-dirty`). Asserts the wire
 * shape, deterministic sort order, subset selection, and the
 * fallback when no source files are found.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { dispatchSecurity } from "../../src/tools/security.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLEAN = join(HERE, "..", "fixtures", "security-clean");
const DIRTY = join(HERE, "..", "fixtures", "security-dirty");

interface Finding {
	id: string;
	severity: "critical" | "high" | "medium" | "low";
	check: string;
	file: string;
	line: number;
	excerpt: string;
	hint: string;
	docsUrl: string;
}

interface ScanShape {
	findings: Finding[];
	confidence: "high" | "medium" | "low";
	knownGaps: string[];
}

interface ErrorShape {
	error: string;
	hint: string;
	confidence: "low";
	knownGaps: string[];
}

describe("security.scan", () => {
	it("returns no findings on a clean fixture", async () => {
		const result = (await dispatchSecurity(CLEAN, "security.scan", {})) as
			| ScanShape
			| ErrorShape;
		expect("error" in result).toBe(false);
		const ok = result as ScanShape;
		expect(ok.findings).toEqual([]);
		expect(ok.confidence).toBe("high");
		expect(ok.knownGaps).toEqual([]);
	});

	it("returns exactly seven findings on the dirty fixture, in the documented order", async () => {
		const result = (await dispatchSecurity(DIRTY, "security.scan", {})) as
			| ScanShape
			| ErrorShape;
		expect("error" in result).toBe(false);
		const ok = result as ScanShape;
		// Exact count — guards against a check firing twice.
		expect(ok.findings).toHaveLength(7);
		// Exact ordered list of (severity, check) pairs — pins the
		// deterministic sort contract to a snapshot. A stable but
		// wrong tie-breaker would no longer pass.
		const trace = ok.findings.map((f) => ({
			severity: f.severity,
			check: f.check,
			file: f.file,
		}));
		expect(trace).toEqual([
			{
				severity: "high",
				check: "csrf_disabled",
				file: "src/bootstrap.ts",
			},
			{
				severity: "high",
				check: "missing_guard_on_mutation_route",
				file: "src/controllers/users.ts",
			},
			{
				severity: "high",
				check: "sql_interpolation",
				file: "src/controllers/users.ts",
			},
			{
				severity: "medium",
				check: "xss_html_raw_output",
				file: "src/bootstrap.ts",
			},
			{
				severity: "medium",
				check: "reflect_metadata_missing",
				file: "src/main.ts",
			},
			{
				severity: "low",
				check: "cookie_missing_flags",
				file: "src/controllers/users.ts",
			},
			{
				severity: "low",
				check: "raw_error_not_reamerror",
				file: "src/controllers/users.ts",
			},
		]);
		// Each finding carries a 16-hex-char id + non-empty hint +
		// docs:-prefixed docsUrl, and ids are pairwise distinct.
		const ids = new Set<string>();
		for (const f of ok.findings) {
			expect(f.id).toMatch(/^[0-9a-f]{16}$/);
			expect(f.hint.length).toBeGreaterThan(0);
			expect(f.docsUrl).toMatch(/^docs:/);
			ids.add(f.id);
		}
		expect(ids.size).toBe(ok.findings.length);
	});

	it("is deterministic across consecutive scans (same id, same order)", async () => {
		const a = (await dispatchSecurity(DIRTY, "security.scan", {})) as ScanShape;
		const b = (await dispatchSecurity(DIRTY, "security.scan", {})) as ScanShape;
		expect(b.findings).toEqual(a.findings);
	});

	it("respects the `checks` subset selection", async () => {
		const result = (await dispatchSecurity(DIRTY, "security.scan", {
			checks: ["sql_interpolation"],
		})) as ScanShape | ErrorShape;
		expect("error" in result).toBe(false);
		const ok = result as ScanShape;
		expect(ok.findings.length).toBeGreaterThan(0);
		for (const f of ok.findings) {
			expect(f.check).toBe("sql_interpolation");
		}
	});

	it("rejects an unknown check ID with a structured error", async () => {
		const result = (await dispatchSecurity(DIRTY, "security.scan", {
			checks: ["bogus_check"],
		})) as ScanShape | ErrorShape;
		expect("error" in result).toBe(true);
		const err = result as ErrorShape;
		expect(err.error).toContain("unknown check");
		expect(err.hint).toContain("valid checks");
		expect(err.confidence).toBe("low");
	});

	it("returns empty findings + a knownGap when no source files exist", async () => {
		const tmpRoot = mkdtempSync(join(tmpdir(), "security-empty-"));
		try {
			writeFileSync(
				join(tmpRoot, "package.json"),
				JSON.stringify({ name: "empty", version: "0.0.0", private: true }),
			);
			const result = (await dispatchSecurity(tmpRoot, "security.scan", {})) as
				| ScanShape
				| ErrorShape;
			expect("error" in result).toBe(false);
			const ok = result as ScanShape;
			expect(ok.findings).toEqual([]);
			expect(ok.knownGaps).toContain("no source files found");
			expect(ok.confidence).toBe("medium");
		} finally {
			rmSync(tmpRoot, { recursive: true, force: true });
		}
	});
});
