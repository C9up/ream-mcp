/**
 * `raw_error_not_reamerror` check (the id predates flare and is kept so
 * callers' `checks` lists keep working).
 *
 * Flags `new Error("...")` inside a controller: an error declared with
 * `createError()` or as an `Exception` subclass (re-exported by
 * `@c9up/ream` from `@c9up/flare`) carries the code and the status that
 * produce a consistent JSON response. A raw `Error` slips through as a
 * 500 with no code.
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
	hint: "declare the error with `createError()` (or an `Exception` subclass) from `@c9up/ream` and throw it instead of `new Error(...)`, so the response carries its code and the right status.",
	docsUrl: "https://reamjs.com/en/guides/basics/exception-handling",
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
