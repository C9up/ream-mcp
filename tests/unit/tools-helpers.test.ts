import { describe, expect, it } from "vitest";
import { errorContent, jsonContent } from "../../src/tools/_helpers.js";

/** Narrow away null/undefined without a `!` assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value");
	return value;
}

describe("ream-mcp > tools/_helpers > jsonContent", () => {
	it("wraps a value as a single text content block with pretty-printed JSON", () => {
		const out = jsonContent({ ok: true, n: 1 });
		expect(out.content).toHaveLength(1);
		expect(defined(out.content[0]).type).toBe("text");
		expect(defined(out.content[0]).text).toBe(
			JSON.stringify({ ok: true, n: 1 }, null, 2),
		);
	});

	it("survives nested structures and arrays in the serialized payload", () => {
		const out = jsonContent({
			items: [1, 2, { k: "v" }],
			meta: { tag: "a" },
		});
		expect(JSON.parse(defined(out.content[0]).text)).toEqual({
			items: [1, 2, { k: "v" }],
			meta: { tag: "a" },
		});
	});

	it("preserves null / boolean / number values verbatim", () => {
		const out = jsonContent({ a: null, b: false, c: 3.14 });
		expect(defined(out.content[0]).text).toContain('"a": null');
		expect(defined(out.content[0]).text).toContain('"b": false');
		expect(defined(out.content[0]).text).toContain('"c": 3.14');
	});
});

describe("ream-mcp > tools/_helpers > errorContent", () => {
	it("returns an isError-flagged single text block with the given message", () => {
		const out = errorContent("boom");
		expect(out.isError).toBe(true);
		expect(out.content).toHaveLength(1);
		expect(defined(out.content[0]).type).toBe("text");
		expect(defined(out.content[0]).text).toBe("boom");
	});

	it("does not transform the message — empty string passes through", () => {
		const out = errorContent("");
		expect(out.isError).toBe(true);
		expect(defined(out.content[0]).text).toBe("");
	});
});
