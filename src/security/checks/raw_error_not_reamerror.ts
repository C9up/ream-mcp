/**
 * `raw_error_not_reamerror` check (Story 33.7).
 *
 * Flags `new Error("...")` inside a controller — the framework's
 * structured error envelope (`ReamError` / `HttpException`
 * subclasses) is what produces consistent JSON responses + status
 * codes. A raw `Error` slips through as a 500 with no structured
 * body.
 *
 * Visits every `NewExpression` whose callee is the bare `Error`
 * identifier (per the spec wording — both `throw new Error()`
 * and `const e = new Error(); throw e;` patterns are flagged).
 *
 * Scope: only files matching `**\/controllers/**\/*.ts` OR
 * containing a class decorated with `@Controller` / `@inject` /
 * `@Service`. Services, utility functions, and tests are
 * intentionally not flagged (story scope cut).
 */

import { Node } from "ts-morph";
import { excerpt, lineOf } from "./_helpers.js";
import type { CheckDefinition, RawFinding } from "./_types.js";

const CONTROLLER_DECORATORS = new Set(["Controller", "inject", "Service"]);

export const rawErrorNotReamerror: CheckDefinition = {
	id: "raw_error_not_reamerror",
	severity: "low",
	hint: "throw a `ReamError` / `HttpException` subclass instead of `new Error(...)` so the framework can render a structured response with the correct status code.",
	docsUrl: "docs:/errors/structured-errors.md",
	run(ctx) {
		if (!isControllerFile(ctx)) return [];
		const findings: RawFinding[] = [];
		ctx.sf.forEachDescendant((node) => {
			if (!Node.isNewExpression(node)) return;
			const ctor = node.getExpression();
			if (!Node.isIdentifier(ctor)) return;
			if (ctor.getText() !== "Error") return;
			const line = lineOf(node);
			findings.push({
				check: "raw_error_not_reamerror",
				line,
				excerpt: excerpt(ctx.sf, line),
			});
		});
		return findings;
	},
};

function isControllerFile(ctx: import("./_types.js").CheckContext): boolean {
	const norm = ctx.relPath.replace(/\\/g, "/");
	if (norm.includes("/controllers/")) return true;
	for (const cls of ctx.sf.getClasses()) {
		for (const dec of cls.getDecorators()) {
			if (CONTROLLER_DECORATORS.has(dec.getName())) return true;
		}
	}
	return false;
}
