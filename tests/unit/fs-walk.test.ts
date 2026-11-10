import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { walkProjectFiles } from "../../src/util/fs-walk.js";

let base: string;
let project: string;
let outside: string;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "fs-walk-"));
	project = join(base, "project");
	outside = join(base, "outside");
	mkdirSync(join(project, "src"), { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(project, "src", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(outside, "leak.ts"), "export const secret = 1;\n");
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

const ts = (name: string): boolean => name.endsWith(".ts");

function rel(files: string[]): string[] {
	return files.map((f) => relative(project, f).replace(/\\/g, "/")).sort();
}

describe("walkProjectFiles", () => {
	it("ends on self-referencing directory links and lists each file once", () => {
		symlinkSync(".", join(project, "src", "l1"), "dir");
		symlinkSync(".", join(project, "src", "l2"), "dir");
		const started = Date.now();
		const r = walkProjectFiles([join(project, "src")], {
			projectRoot: project,
			accept: ts,
			maxFiles: 100,
		});
		expect(Date.now() - started).toBeLessThan(2000);
		expect(rel(r.files)).toEqual(["src/a.ts"]);
	});

	it("does not follow a directory link that leaves the project", () => {
		symlinkSync(outside, join(project, "src", "ext"), "dir");
		const r = walkProjectFiles([join(project, "src")], {
			projectRoot: project,
			accept: ts,
			maxFiles: 100,
		});
		expect(rel(r.files)).toEqual(["src/a.ts"]);
	});

	it("does not read a file link whose target is outside", () => {
		symlinkSync(join(outside, "leak.ts"), join(project, "src", "leak.ts"));
		const r = walkProjectFiles([join(project, "src")], {
			projectRoot: project,
			accept: ts,
			maxFiles: 100,
		});
		expect(rel(r.files)).toEqual(["src/a.ts"]);
	});

	it("keeps an in-project link to a sibling directory", () => {
		mkdirSync(join(project, "shared"));
		writeFileSync(join(project, "shared", "s.ts"), "export {};\n");
		symlinkSync(join(project, "shared"), join(project, "src", "shared"), "dir");
		const r = walkProjectFiles([join(project, "src")], {
			projectRoot: project,
			accept: ts,
			maxFiles: 100,
		});
		expect(rel(r.files)).toEqual(["src/a.ts", "src/shared/s.ts"]);
	});

	it("refuses a start directory that is itself a link out of the project", () => {
		symlinkSync(outside, join(project, "linked-src"), "dir");
		const r = walkProjectFiles([join(project, "linked-src")], {
			projectRoot: project,
			accept: ts,
			maxFiles: 100,
		});
		expect(r.files).toEqual([]);
	});

	it("stops walking, not only collecting, at the file cap", () => {
		for (let i = 0; i < 5; i++) {
			const d = join(project, "src", `d${i}`);
			mkdirSync(d);
			writeFileSync(join(d, "x.ts"), "");
		}
		let visits = 0;
		const r = walkProjectFiles([join(project, "src")], {
			projectRoot: project,
			accept: (name) => {
				visits++;
				return ts(name);
			},
			maxFiles: 2,
		});
		expect(r.files).toHaveLength(2);
		expect(r.capped).toBe(true);
		expect(visits).toBeLessThanOrEqual(3);
	});

	it("does not descend past maxDepth", () => {
		let dir = join(project, "src");
		for (let i = 0; i < 6; i++) {
			dir = join(dir, `n${i}`);
			mkdirSync(dir);
		}
		writeFileSync(join(dir, "deep.ts"), "");
		const r = walkProjectFiles([join(project, "src")], {
			projectRoot: project,
			accept: ts,
			maxFiles: 100,
			maxDepth: 3,
		});
		expect(rel(r.files)).toEqual(["src/a.ts"]);
	});
});
