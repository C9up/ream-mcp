/**
 * `quality.package_report` integration tests — Story 33.5.
 *
 * The introspect-app fixture is a single-package workspace
 * (`introspect-app-fixture`); the report should come back with a
 * single row that matches the fixture's name and contains
 * non-trivial `files`/`loc` counts.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { dispatchQuality } from "../../src/tools/quality.js";
import { _resetCache } from "../../src/util/ts-static-parser.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "introspect-app");

interface ReportShape {
	packages: Array<{
		name: string;
		files: number;
		loc: number;
		publicExports: number;
		testCoverage?: {
			lines: number;
			branches: number;
			functions: number;
			statements: number;
		};
		lintIssues: number;
		circularDeps: number;
	}>;
	confidence: "high" | "medium" | "low";
	knownGaps: string[];
}

beforeAll(() => {
	_resetCache();
});

describe("quality > package_report", () => {
	it("returns one row for the fixture package with non-trivial counts", () => {
		const result = dispatchQuality(
			FIXTURE,
			"quality.package_report",
		) as ReportShape;

		expect(result.packages.length).toBe(1);
		const pkg = result.packages[0];
		expect(pkg.name).toBe("introspect-app-fixture");
		expect(pkg.files).toBeGreaterThan(0);
		expect(pkg.loc).toBeGreaterThan(0);
		expect(pkg.lintIssues).toBe(0);
		// No coverage file is shipped; the row omits testCoverage.
		expect(pkg.testCoverage).toBeUndefined();
		// `cycle-a` ↔ `cycle-b` are within the same package, so at the
		// package-scope graph there is no cross-package cycle.
		expect(pkg.circularDeps).toBe(0);
	});

	it("filters by name when `package` arg is supplied", () => {
		const result = dispatchQuality(FIXTURE, "quality.package_report", {
			package: "introspect-app-fixture",
		}) as ReportShape;
		expect(result.packages.length).toBe(1);
		expect(result.packages[0].name).toBe("introspect-app-fixture");
	});

	it("returns the structured error shape when the package is unknown", () => {
		const result = dispatchQuality(FIXTURE, "quality.package_report", {
			package: "not-a-real-package",
		}) as {
			error: string;
			hint: string;
			confidence: string;
		};
		expect(result.error).toContain("not-a-real-package");
		expect(result.hint).toContain("introspect-app-fixture");
		expect(result.confidence).toBe("low");
	});
});
