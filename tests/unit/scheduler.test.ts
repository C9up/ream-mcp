import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchScheduler } from "../../src/tools/scheduler.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "ream-mcp-scheduler-"));
	mkdirSync(join(tmpRoot, "app"));
	writeFileSync(
		join(tmpRoot, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "ESNext",
				experimentalDecorators: true,
				emitDecoratorMetadata: true,
			},
			include: ["app/**/*.ts"],
		}),
	);
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("scheduler.list_tasks", () => {
	it("returns an empty list with knownGaps when nothing is scheduled", () => {
		const res = dispatchScheduler(tmpRoot, "scheduler.list_tasks") as {
			tasks: unknown[];
			knownGaps: string[];
		};
		expect(res.tasks).toEqual([]);
		expect(res.knownGaps[0]).toMatch(/No @Schedule decorators/);
	});

	it("picks up @Schedule(cronExpr) method decorators with class + method context", () => {
		writeFileSync(
			join(tmpRoot, "app/cleanup.ts"),
			`
import { Schedule } from "@c9up/ream";
export class Cleanup {
  @Schedule("0 */5 * * *")
  async runCleanup() {}
}
`,
		);
		const res = dispatchScheduler(tmpRoot, "scheduler.list_tasks") as {
			tasks: Array<{
				cronExpr?: string;
				source: string;
				className?: string;
				methodName?: string;
				confidence: string;
			}>;
		};
		expect(res.tasks).toHaveLength(1);
		expect(res.tasks[0].cronExpr).toBe("0 */5 * * *");
		expect(res.tasks[0].source).toBe("decorator");
		expect(res.tasks[0].className).toBe("Cleanup");
		expect(res.tasks[0].methodName).toBe("runCleanup");
		expect(res.tasks[0].confidence).toBe("high");
	});

	it("picks up scheduler.register(name, cronExpr, …) call sites", () => {
		writeFileSync(
			join(tmpRoot, "app/jobs.ts"),
			`
const scheduler: any = {};
scheduler.register("nightly-rotate", "0 0 * * *", () => {});
`,
		);
		const res = dispatchScheduler(tmpRoot, "scheduler.list_tasks") as {
			tasks: Array<{
				name?: string;
				cronExpr?: string;
				source: string;
				confidence: string;
			}>;
		};
		const reg = res.tasks.find((t) => t.source === "register-call");
		expect(reg).toBeDefined();
		expect(reg?.name).toBe("nightly-rotate");
		expect(reg?.cronExpr).toBe("0 0 * * *");
		expect(reg?.confidence).toBe("high");
	});

	it("flags medium confidence when the cron expression isn't a string literal", () => {
		writeFileSync(
			join(tmpRoot, "app/dyn.ts"),
			`
import { Schedule } from "@c9up/ream";
const CRON = "0 0 * * *";
export class Dyn {
  @Schedule(CRON)
  async run() {}
}
`,
		);
		const res = dispatchScheduler(tmpRoot, "scheduler.list_tasks") as {
			tasks: Array<{ cronExpr?: string; confidence: string; notes: string[] }>;
		};
		expect(res.tasks[0].cronExpr).toBeUndefined();
		expect(res.tasks[0].confidence).toBe("medium");
		expect(res.tasks[0].notes.join(" ")).toMatch(/string literal/);
	});
});
