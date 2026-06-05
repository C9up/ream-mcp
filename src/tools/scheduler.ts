/**
 * `scheduler.*` MCP tools.
 *
 * Static scan via ts-morph — no Scheduler NAPI load, no app boot.
 * Surfaces every cron-style task registration the project source
 * tree declares, whether via `@Schedule(cronExpr)` method decorators
 * or `scheduler.register(name, cronExpr, …)` call sites.
 */

import { type Decorator, Node } from "ts-morph";

import {
	findCallExpressions,
	isLoadError,
	loadProject,
} from "../util/ts-static-parser.js";
import { isSchedulerTool, SCHEDULER_TOOLS } from "./scheduler.descriptors.js";

export { isSchedulerTool, SCHEDULER_TOOLS };

type Confidence = "high" | "medium" | "low";

interface TaskSite {
	name?: string;
	cronExpr?: string;
	source: "decorator" | "register-call";
	className?: string;
	methodName?: string;
	file: string;
	line: number;
	confidence: Confidence;
	notes: string[];
}

interface ShapedError {
	error: string;
	hint: string;
}

function shapeError(error: string, hint: string): ShapedError {
	return { error, hint };
}

export function dispatchScheduler(
	root: string,
	name: string,
	_args: Record<string, unknown> = {},
): unknown {
	const loaded = loadProject(root);
	if (isLoadError(loaded)) return shapeError(loaded.error, loaded.hint);
	switch (name) {
		case "scheduler.list_tasks":
			return listTasks(loaded.project);
		default:
			return shapeError(
				`Unknown scheduler tool: ${name}`,
				"This dispatcher only handles `scheduler.list_tasks`.",
			);
	}
}

function listTasks(project: Parameters<typeof findCallExpressions>[0]) {
	const tasks = [
		...collectScheduleDecorators(project),
		...collectRegisterCalls(project),
	];
	tasks.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
	return {
		tasks,
		confidence: tasks.length === 0 ? "high" : aggregateConfidence(tasks),
		knownGaps:
			tasks.length === 0
				? [
						"No @Schedule decorators or scheduler.register() calls found in the project source tree.",
					]
				: [],
	};
}

/** Collect `@Schedule(cronExpr)` method decorators across the project. */
function collectScheduleDecorators(
	project: Parameters<typeof findCallExpressions>[0],
): TaskSite[] {
	const tasks: TaskSite[] = [];
	for (const sf of project.getSourceFiles()) {
		for (const cls of sf.getClasses()) {
			const className = cls.getName() ?? "<anonymous>";
			for (const method of cls.getMethods()) {
				for (const dec of method.getDecorators()) {
					if (dec.getName() !== "Schedule") continue;
					tasks.push(
						parseScheduleDecorator(
							dec,
							className,
							method.getName(),
							sf.getFilePath(),
						),
					);
				}
			}
		}
	}
	return tasks;
}

/** Parse a single `@Schedule(...)` decorator into a task site. */
function parseScheduleDecorator(
	dec: Decorator,
	className: string,
	methodName: string,
	file: string,
): TaskSite {
	const arg0 = dec.getArguments()[0];
	const notes: string[] = [];
	let confidence: Confidence = "high";
	let cronExpr: string | undefined;
	if (arg0 !== undefined && Node.isStringLiteral(arg0)) {
		cronExpr = arg0.getLiteralValue();
	} else if (arg0 !== undefined) {
		confidence = "medium";
		notes.push("cron expression is not a string literal");
	} else {
		confidence = "low";
		notes.push("@Schedule called without arguments");
	}
	return {
		cronExpr,
		source: "decorator",
		className,
		methodName,
		file,
		line: dec.getStartLineNumber(),
		confidence,
		notes,
	};
}

/** Collect `scheduler.register(name, cronExpr, …)` call sites. */
function collectRegisterCalls(
	project: Parameters<typeof findCallExpressions>[0],
): TaskSite[] {
	const tasks: TaskSite[] = [];
	for (const site of findCallExpressions(
		project,
		(leaf) => leaf === "register",
	)) {
		const task = parseRegisterCall(site);
		if (task) tasks.push(task);
	}
	return tasks;
}

/**
 * Parse a `register(...)` call into a task site, or null when the receiver is
 * not a scheduler (avoids false positives from container/router `.register`).
 */
function parseRegisterCall(
	site: ReturnType<typeof findCallExpressions>[number],
): TaskSite | null {
	const expr = site.expr.getExpression();
	// Only treat the call as a scheduler.register if the receiver ends with
	// `scheduler` — avoids container.register / router.register / etc.
	if (!Node.isPropertyAccessExpression(expr)) return null;
	const receiver = expr.getExpression().getText();
	if (!/scheduler$|Scheduler$/i.test(receiver.split(".").pop() ?? "")) {
		return null;
	}
	const args = site.expr.getArguments();
	const argName = args[0];
	const argCron = args[1];
	const notes: string[] = [];
	let confidence: Confidence = "high";
	let name: string | undefined;
	let cronExpr: string | undefined;
	if (argName !== undefined && Node.isStringLiteral(argName)) {
		name = argName.getLiteralValue();
	} else if (argName !== undefined) {
		confidence = "medium";
		notes.push("task name is not a string literal");
	}
	if (argCron !== undefined && Node.isStringLiteral(argCron)) {
		cronExpr = argCron.getLiteralValue();
	} else if (argCron !== undefined) {
		confidence = "medium";
		notes.push("cron expression is not a string literal");
	} else {
		confidence = "low";
		notes.push("scheduler.register called without cron expression");
	}
	return {
		name,
		cronExpr,
		source: "register-call",
		file: site.file,
		line: site.line,
		confidence,
		notes,
	};
}

function aggregateConfidence(sites: TaskSite[]): Confidence {
	let worst: Confidence = "high";
	for (const s of sites) {
		if (s.confidence === "low") return "low";
		if (s.confidence === "medium") worst = "medium";
	}
	return worst;
}
