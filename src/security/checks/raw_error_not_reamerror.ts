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
 * Visits every `new Error(...)` and `Error(...)` (both `throw new Error()`
 * and `const e = new Error(); throw e;` are flagged).
 *
 * Scope: controllers, as a Ream application lays them out: a file under a
 * `controllers/` directory (`app/controllers/`,
 * `app/modules/<module>/controllers/`), or named `*_controller.ts` /
 * `*Controller.ts`. Services, middleware, utilities and tests are not
 * flagged. Ream has no `@Controller` decorator, and `@inject()` / `@Service()`
 * mark services as much as controllers, so decorators do not decide it.
 */

import { Node } from "ts-morph";
import { excerpt, lineOf } from "./_helpers.js";
import type { CheckDefinition, RawFinding } from "./_types.js";

const CONTROLLER_FILE = /(?:^|\/)[^/]*(?:_controller|Controller)\.tsx?$/;

export const rawErrorNotReamerror: CheckDefinition = {
	id: "raw_error_not_reamerror",
	severity: "low",
	hint: "declare the error with `createError()` (or an `Exception` subclass) from `@c9up/ream` and throw it instead of `new Error(...)`, so the response carries its code and the right status.",
	docsUrl: "https://reamjs.com/en/guides/basics/exception-handling",
	run(ctx) {
		if (!isControllerFile(ctx.relPath)) return [];
		const findings: RawFinding[] = [];
		ctx.sf.forEachDescendant((node) => {
			if (!Node.isNewExpression(node) && !Node.isCallExpression(node)) return;
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

function isControllerFile(relPath: string): boolean {
	const norm = relPath.replace(/\\/g, "/");
	return (
		norm.startsWith("controllers/") ||
		norm.includes("/controllers/") ||
		CONTROLLER_FILE.test(norm)
	);
}
