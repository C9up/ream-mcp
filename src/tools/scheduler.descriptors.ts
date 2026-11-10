/**
 * Lightweight tool-list descriptors for `scheduler.*`.
 *
 * Kept in its own file so `server.ts` can answer `tools/list`
 * without pulling in ts-morph or the scheduler NAPI. The actual
 * handler in `scheduler.ts` is dynamic-imported on first dispatch
 * and uses a static ts-morph scan — no app boot, no NAPI load.
 */

import { READ_ONLY, type ToolDescriptor } from "./descriptor.js";

export const SCHEDULER_TOOLS: ToolDescriptor[] = [
	{
		name: "scheduler.list_tasks",
		annotations: READ_ONLY,
		description:
			"Static scan of cron task registrations across the project. Looks for `scheduler.register(name, cronExpr, …)` calls and `@Schedule(cronExpr)` decorators. Returns each task's name, cron expression, source file/line, and a confidence score that drops to `medium` when the name or expression isn't a string literal.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
];

const NAMES = new Set(SCHEDULER_TOOLS.map((t) => t.name));

export function isSchedulerTool(name: string): boolean {
	return NAMES.has(name);
}
