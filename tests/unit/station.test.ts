import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchStation } from "../../src/tools/station.js";

/** Narrow away null/undefined without a `!` assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value");
	return value;
}


let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "ream-mcp-station-"));
	// Minimum scaffolding so loadProject() accepts the root.
	mkdirSync(join(tmpRoot, "app"));
	writeFileSync(
		join(tmpRoot, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { target: "ES2022", module: "ESNext" },
			include: ["app/**/*.ts"],
		}),
	);
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("station.list_resources", () => {
	it("returns an empty list with knownGaps when no defineResource calls exist", () => {
		const res = dispatchStation(tmpRoot, "station.list_resources") as {
			resources: unknown[];
			knownGaps: string[];
		};
		expect(res.resources).toEqual([]);
		expect(defined(res.knownGaps[0])).toMatch(/No defineResource/);
	});

	it("extracts name + entity + actions from a literal call", () => {
		writeFileSync(
			join(tmpRoot, "app/resources.ts"),
			`
import { defineResource } from "@c9up/station";
class Article {}
export const articleResource = defineResource({
  name: "articles",
  entity: Article,
  actions: ["list", "show", "create"],
});
`,
		);
		const res = dispatchStation(tmpRoot, "station.list_resources") as {
			resources: Array<{
				name?: string;
				entity?: string;
				actions: string[];
				confidence: string;
			}>;
		};
		expect(res.resources).toHaveLength(1);
		expect(defined(res.resources[0]).name).toBe("articles");
		expect(defined(res.resources[0]).entity).toBe("Article");
		expect(defined(res.resources[0]).actions).toEqual(["list", "show", "create"]);
		expect(defined(res.resources[0]).confidence).toBe("high");
	});

	it("drops to medium confidence when name is omitted (runtime slug-derives from entity)", () => {
		writeFileSync(
			join(tmpRoot, "app/resources.ts"),
			`
import { defineResource } from "@c9up/station";


class Order {}
export const orderResource = defineResource({ entity: Order });
`,
		);
		const res = dispatchStation(tmpRoot, "station.list_resources") as {
			resources: Array<{
				entity?: string;
				confidence: string;
				notes: string[];
			}>;
		};
		expect(defined(res.resources[0]).entity).toBe("Order");
		expect(defined(res.resources[0]).confidence).toBe("medium");
		expect(defined(res.resources[0]).notes.join(" ")).toMatch(/kebab-case/);
	});
});
