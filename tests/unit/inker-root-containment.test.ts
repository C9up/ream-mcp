/**
 * `root` comes from the tool call. An absolute path was taken as-is and a
 * relative one could climb with `..`, so a tool meant to read a project's views
 * would happily walk `/etc` or a home directory.
 */
import { describe, expect, it } from "vitest";
import { dispatchInker } from "../../src/tools/inker.js";

const PROJECT = "/tmp/some-project";

function isError(result: unknown): result is { error: string } {
	return typeof result === "object" && result !== null && "error" in result;
}

describe("ream-mcp > templates root containment", () => {
	it("refuses an absolute path outside the project", async () => {
		const result = await dispatchInker(PROJECT, "inker.list_templates", {
			root: "/etc",
		});
		expect(isError(result)).toBe(true);
		expect(JSON.stringify(result)).toContain("outside the project");
	});

	it("refuses a relative path that climbs out", async () => {
		const result = await dispatchInker(PROJECT, "inker.list_templates", {
			root: "../../../../etc",
		});
		expect(JSON.stringify(result)).toContain("outside the project");
	});

	it("refuses it on render_test too", async () => {
		const result = await dispatchInker(PROJECT, "inker.render_test", {
			root: "/etc",
			template: "passwd",
		});
		expect(JSON.stringify(result)).toContain("outside the project");
	});

	it("still accepts a path inside the project", async () => {
		const result = await dispatchInker(PROJECT, "inker.list_templates", {
			root: "resources/views",
		});
		// The directory does not exist here, so it reports THAT — not containment.
		expect(JSON.stringify(result)).not.toContain("outside the project");
	});
});
