import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { excerpt, lineOf } from "../../src/security/checks/_helpers.js";

function fileWith(source: string) {
	const project = new Project({ useInMemoryFileSystem: true });
	return project.createSourceFile("t.ts", source);
}

describe("ream-mcp > security/checks/_helpers > lineOf", () => {
	it("returns the 1-indexed start line of a node", () => {
		const sf = fileWith("const a = 1;\nconst b = 2;\nconst c = 3;\n");
		const decl = sf.getVariableDeclarations()[2];
		expect(lineOf(decl)).toBe(3);
	});
});

describe("ream-mcp > security/checks/_helpers > excerpt", () => {
	it("returns the trimmed source line at the given 1-indexed number", () => {
		const sf = fileWith("const a = 1;\n  const b = 2;\nconst c = 3;\n");
		expect(excerpt(sf, 2)).toBe("const b = 2;");
	});

	it("strips a trailing CR so CRLF and LF inputs match", () => {
		const sf = fileWith("first\r\nsecond\r\nthird\r\n");
		expect(excerpt(sf, 2)).toBe("second");
	});

	it("expands tabs to 4 spaces in the excerpt", () => {
		const sf = fileWith("plain\n\tindented\n");
		expect(excerpt(sf, 2)).toBe("indented");
	});

	it("elides at 120 chars with a trailing ellipsis when source line is longer", () => {
		const long = "x".repeat(200);
		const sf = fileWith(`${long}\n`);
		const out = excerpt(sf, 1);
		expect(out).toHaveLength(120);
		expect(out.endsWith("…")).toBe(true);
		expect(out.startsWith("x".repeat(119))).toBe(true);
	});

	it("returns an empty string for an out-of-range line", () => {
		const sf = fileWith("only-one-line\n");
		expect(excerpt(sf, 99)).toBe("");
	});
});
