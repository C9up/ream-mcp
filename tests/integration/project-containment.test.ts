/**
 * Tools that read "the project" read only the project: symlinks inside it can
 * neither loop a walk forever nor take it to another directory.
 */

import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchBmad } from "../../src/tools/bmad.js";
import { dispatchInker } from "../../src/tools/inker.js";
import { dispatchSecurity } from "../../src/tools/security.js";
import { walkWorkspacePackages } from "../../src/util/package-walker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BMAD_MODULE = pathToFileURL(
	join(HERE, "..", "..", "src", "tools", "bmad.ts"),
).href;

// A source line interpolating into SQL, written out literally (not evaluated).
const SQL_LEAK = [
	'const API_TOKEN = "sk_live_OUTSIDE_ROOT_1234";',
	`db.query(\`SELECT * FROM t WHERE token = \${API_TOKEN}\`); // FR9`,
	"",
].join("\n");

let base: string;
let project: string;
let outside: string;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "containment-"));
	project = join(base, "project");
	outside = join(base, "outside");
	mkdirSync(join(project, "src"), { recursive: true });
	mkdirSync(join(project, "_bmad-output", "planning-artifacts"), {
		recursive: true,
	});
	mkdirSync(outside);
	writeFileSync(
		join(project, "package.json"),
		JSON.stringify({ name: "app", private: true }),
	);
	writeFileSync(join(project, "src", "a.ts"), "export const a = 1; // FR1\n");
	writeFileSync(join(outside, "leak.ts"), SQL_LEAK);
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

function field(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return Object.fromEntries(Object.entries(value))[key];
}

function paths(list: unknown, key: string): string[] {
	if (!Array.isArray(list)) return [];
	return list.map((item) => String(field(item, key)));
}

describe("bmad.trace", () => {
	it("returns despite two self-referencing directory links", () => {
		symlinkSync(".", join(project, "src", "l1"), "dir");
		symlinkSync(".", join(project, "src", "l2"), "dir");
		// In a child process: a regression is an endless synchronous walk, which
		// would hang this worker instead of failing the test.
		const script = `const { dispatchBmad } = await import(${JSON.stringify(BMAD_MODULE)});
const r = await dispatchBmad(${JSON.stringify(project)}, "bmad.trace", { requirement_id: "FR1" });
process.stdout.write(JSON.stringify(r));`;
		const child = spawnSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", script],
			{ encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" },
		);
		expect(child.signal, child.stderr).toBeNull();
		const result: unknown = JSON.parse(child.stdout);
		expect(paths(field(result, "codeFiles"), "path")).toEqual(["src/a.ts"]);
	});

	it("does not report files reached through a link out of the project", async () => {
		symlinkSync(outside, join(project, "src", "ext"), "dir");
		writeFileSync(join(project, "src", "in.ts"), "// FR9\n");
		const r = await dispatchBmad(project, "bmad.trace", {
			requirement_id: "FR9",
		});
		expect(paths(field(r, "codeFiles"), "path")).toEqual(["src/in.ts"]);
	});
});

describe("security.scan", () => {
	it("does not scan a directory linked from outside the project", async () => {
		symlinkSync(outside, join(project, "src", "ext"), "dir");
		writeFileSync(join(project, "src", "in.ts"), SQL_LEAK);
		const r = await dispatchSecurity(project, "security.scan", {
			checks: ["sql_interpolation"],
		});
		const files = paths(field(r, "findings"), "file");
		expect(files).toContain("src/in.ts");
		expect(files.some((f) => f.startsWith("src/ext/"))).toBe(false);
	});

	it("does not scan templates whose root links out of the project", async () => {
		mkdirSync(join(project, "resources"));
		mkdirSync(join(outside, "views"));
		writeFileSync(join(outside, "views", "private.inker"), "{{{ secret }}}\n");
		symlinkSync(outside, join(project, "resources", "templates"), "dir");
		const r = await dispatchSecurity(project, "security.scan", {
			checks: ["xss_html_raw_output"],
		});
		expect(paths(field(r, "findings"), "file")).toEqual([]);
	});
});

describe("inker", () => {
	beforeEach(() => {
		mkdirSync(join(outside, "views"));
		writeFileSync(join(outside, "views", "private.inker"), "secret body\n");
	});

	it("refuses a default templates root that links out of the project", async () => {
		mkdirSync(join(project, "resources"));
		symlinkSync(outside, join(project, "resources", "templates"), "dir");
		const r = await dispatchInker(project, "inker.list_templates", {});
		expect(String(field(r, "error"))).toContain("outside the project");
		expect(JSON.stringify(r)).not.toContain(base);
	});

	it("refuses a caller root that links out of the project", async () => {
		symlinkSync(outside, join(project, "src", "ext"), "dir");
		for (const tool of ["inker.list_templates", "inker.render_test"]) {
			const r = await dispatchInker(project, tool, {
				root: "src/ext",
				template: "views/private",
			});
			expect(String(field(r, "error")), tool).toContain("outside the project");
		}
	});

	it("skips, and refuses to render, a template file linked from outside", async () => {
		const templates = join(project, "resources", "templates");
		mkdirSync(join(templates, "views"), { recursive: true });
		writeFileSync(join(templates, "views", "home.inker"), "home\n");
		symlinkSync(
			join(outside, "views", "private.inker"),
			join(templates, "views", "private.inker"),
		);
		const listed = await dispatchInker(project, "inker.list_templates", {});
		expect(paths(field(listed, "templates"), "relPath")).toEqual([
			"views/home.inker",
		]);
		const rendered = await dispatchInker(project, "inker.render_test", {
			template: "views/private",
		});
		expect(String(field(rendered, "error"))).toContain("outside the project");
	});

	it("does not echo the absolute templates root when it is missing", async () => {
		const r = await dispatchInker(project, "inker.list_templates", {});
		expect(String(field(r, "error"))).toContain("resources/templates");
		expect(JSON.stringify(r)).not.toContain(base);
	});
});

describe("bmad.update_status", () => {
	const YAML = "development_status:\n  1-1-a: in-progress\n";

	it("refuses a BMAD root that links out of the project", async () => {
		rmSync(join(project, "_bmad-output"), { recursive: true });
		mkdirSync(join(outside, "bmad", "implementation-artifacts"), {
			recursive: true,
		});
		const sprint = join(
			outside,
			"bmad",
			"implementation-artifacts",
			"sprint-status.yaml",
		);
		writeFileSync(sprint, YAML);
		symlinkSync(join(outside, "bmad"), join(project, "_bmad-output"), "dir");
		const r = await dispatchBmad(project, "bmad.update_status", {
			id: "1-1-a",
			status: "review",
			dryRun: false,
			confirm: true,
		});
		expect(field(r, "error")).toBe("no BMAD root resolved");
		expect(readFileSync(sprint, "utf8")).toBe(YAML);
	});

	it("refuses a sprint-status file that links out of the project", async () => {
		const artifacts = join(project, "_bmad-output", "implementation-artifacts");
		mkdirSync(artifacts);
		const target = join(outside, "sprint-status.yaml");
		writeFileSync(target, YAML);
		symlinkSync(target, join(artifacts, "sprint-status.yaml"));
		const r = await dispatchBmad(project, "bmad.update_status", {
			id: "1-1-a",
			status: "review",
			dryRun: false,
			confirm: true,
		});
		expect(String(field(r, "error"))).toContain("outside the project");
		expect(readFileSync(target, "utf8")).toBe(YAML);
	});
});

describe("walkWorkspacePackages", () => {
	it("does not discover a package linked from outside the project", () => {
		mkdirSync(join(outside, "pkg", "src"), { recursive: true });
		writeFileSync(
			join(outside, "pkg", "package.json"),
			JSON.stringify({ name: "evil" }),
		);
		writeFileSync(join(outside, "pkg", "src", "index.ts"), "export {};\n");
		mkdirSync(join(project, "packages"));
		symlinkSync(join(outside, "pkg"), join(project, "packages", "evil"), "dir");
		expect(walkWorkspacePackages(project).map((p) => p.name)).not.toContain(
			"evil",
		);
	});

	it("rejects an entry file that links out of the package", () => {
		mkdirSync(join(project, "packages", "ok", "src"), { recursive: true });
		writeFileSync(
			join(project, "packages", "ok", "package.json"),
			JSON.stringify({ name: "ok", main: "src/index.ts" }),
		);
		symlinkSync(
			join(outside, "leak.ts"),
			join(project, "packages", "ok", "src", "index.ts"),
		);
		expect(walkWorkspacePackages(project).map((p) => p.name)).not.toContain(
			"ok",
		);
	});
});
