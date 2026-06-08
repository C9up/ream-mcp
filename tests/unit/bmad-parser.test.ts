/**
 * Unit tests for the BMAD `epics.md` heading walker — Story 33.8.
 *
 * Each test feeds a small in-memory string to `parseEpicsFile`
 * and asserts the parsed shape.
 */

import { describe, expect, it } from "vitest";

import { parseEpicsFile, sliceSection } from "../../src/util/bmad-parser.js";

describe("parseEpicsFile", () => {
	it("parses a simple Epic with two Stories", () => {
		const text = [
			"## Epic 1: Foundations",
			"intro paragraph",
			"### Story 1.1: Bootstrap",
			"body",
			"### Story 1.2: First feature",
			"body",
		].join("\n");
		const r = parseEpicsFile(text);
		expect(r.parserWarnings).toEqual([]);
		expect(r.epics).toHaveLength(1);
		expect(r.epics[0].id).toBe("1");
		expect(r.epics[0].title).toBe("Foundations");
		expect(r.epics[0].stories).toHaveLength(2);
		expect(r.epics[0].stories[0].id).toBe("1.1");
		expect(r.epics[0].stories[1].id).toBe("1.2");
	});

	it("tolerates emoji prefixes on the heading", () => {
		const text = [
			"## 🚀 Epic 7: Scheduler",
			"### ✨ Story 7.3: Cron expressions",
			"body",
		].join("\n");
		const r = parseEpicsFile(text);
		expect(r.parserWarnings).toEqual([]);
		expect(r.epics[0].id).toBe("7");
		expect(r.epics[0].title).toBe("Scheduler");
		expect(r.epics[0].stories[0].id).toBe("7.3");
		expect(r.epics[0].stories[0].title).toBe("Cron expressions");
	});

	it("captures a trailing status badge on Story headings", () => {
		const text = [
			"## Epic 12: Migrations",
			"### Story 12.4: Backfill column [done]",
		].join("\n");
		const r = parseEpicsFile(text);
		expect(r.parserWarnings).toEqual([]);
		const story = r.epics[0].stories[0];
		expect(story.title).toBe("Backfill column");
		expect(story.statusBadge).toBe("done");
	});

	it("warns when a Story is orphaned from its parent Epic", () => {
		const text = [
			"## Epic 5: Cache",
			"### Story 7.1: Stray story",
			"body",
		].join("\n");
		const r = parseEpicsFile(text);
		expect(r.epics).toHaveLength(1);
		expect(r.epics[0].stories).toEqual([]);
		expect(r.parserWarnings.length).toBeGreaterThan(0);
		expect(r.parserWarnings[0]).toContain("Story 7.1");
	});

	it("warns on heading-shaped lines that mention Epic/Story but don't match", () => {
		const text = [
			"## Epic 33: Ream MCP",
			"## Epic 33-bis: malformed",
			"### Story badly formed: nope",
		].join("\n");
		const r = parseEpicsFile(text);
		expect(r.epics).toHaveLength(1);
		expect(r.parserWarnings.length).toBeGreaterThan(0);
	});

	it("sorts epics and stories deterministically", () => {
		const text = [
			"## Epic 33: MCP",
			"### Story 33.7: Security",
			"### Story 33.2: Docs",
			"## Epic 28: Scheduler",
			"### Story 28.1: Cron",
		].join("\n");
		const r = parseEpicsFile(text);
		expect(r.epics.map((e) => e.id)).toEqual(["28", "33"]);
		expect(r.epics[1].stories.map((s) => s.id)).toEqual(["33.2", "33.7"]);
	});

	it("records start/end line numbers for sliceSection consumers", () => {
		const text = [
			"# Epics doc",
			"",
			"## Epic 1: Foo",
			"intro",
			"### Story 1.1: Bar",
			"body line 1",
			"body line 2",
			"## Epic 2: Baz",
		].join("\n");
		const r = parseEpicsFile(text);
		const story = r.epics[0].stories[0];
		expect(story.startLine).toBe(5);
		expect(story.endLine).toBe(7);
		expect(sliceSection(text, story.startLine, story.endLine)).toBe(
			["### Story 1.1: Bar", "body line 1", "body line 2"].join("\n"),
		);
	});

	it("parses the live epics.md without errors", async () => {
		const { readFileSync, existsSync } = await import("node:fs");
		const { findReamRepoRoot } = await import("../test-utils.js");
		const root = findReamRepoRoot();
		if (root === null) return; // gracefully skip when run outside repo
		const path = `${root}/_bmad-output/planning-artifacts/epics.md`;
		if (!existsSync(path)) return;
		const text = readFileSync(path, "utf8");
		const r = parseEpicsFile(text);
		// Live file should have at least 30 epics and zero
		// hard-stop warnings (warnings allowed but not catastrophic).
		expect(r.epics.length).toBeGreaterThan(30);
		// Story 33.8 must appear with the right title.
		const epic33 = r.epics.find((e) => e.id === "33");
		expect(epic33).toBeDefined();
		const story = epic33?.stories.find((s) => s.id === "33.8");
		expect(story).toBeDefined();
		expect(story?.title).toContain("BMAD");
	});
});
