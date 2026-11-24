/**
 * `xss_html_raw_output` check.
 *
 * inker escapes `{{ expr }}`; three things print without escaping:
 *
 *   1. the raw output form `{{{ expr }}}` in a `.inker` template
 *      (`resources/templates/**`, scanned line by line by the dispatcher,
 *      see `scanInkerTemplates` in `tools/security.ts`);
 *   2. a `SafeString` (`new SafeString(value)` from `@c9up/inker`), printed
 *      raw even inside `{{ }}`, typically returned by a helper or a global;
 *   3. the `html.safe(value)` global, which wraps its value in one.
 *
 * In TypeScript, 2 and 3 are flagged when the wrapped value is not markup
 * the code wrote: a string literal, or a template literal whose every
 * interpolation goes through `html.escape(...)`, is trusted; anything else
 * may carry user input. False negatives are accepted (no taint tracking).
 */

import { Node } from "ts-morph";
import { excerpt, lineOf } from "./_helpers.js";
import type { CheckDefinition, RawFinding } from "./_types.js";

export const xssHtmlRawOutput: CheckDefinition = {
	id: "xss_html_raw_output",
	severity: "medium",
	hint: "print untrusted data with inker's escaped `{{ value }}`; keep `{{{ }}}`, `new SafeString()` and `html.safe()` for markup you wrote, or escape each value first with `html.escape(value)`. User HTML that must stay HTML goes through blackhole's `sanitizeResponse(body, 'text/html')`.",
	docsUrl:
		"https://reamjs.com/en/guides/frontend/templates/#html-escape-vs-raw",
	run(ctx) {
		const findings: RawFinding[] = [];
		ctx.sf.forEachDescendant((node) => {
			let value: Node | undefined;
			if (Node.isNewExpression(node)) {
				const ctor = node.getExpression();
				if (!Node.isIdentifier(ctor) || ctor.getText() !== "SafeString") return;
				[value] = node.getArguments();
			} else if (Node.isCallExpression(node)) {
				if (!isHtmlSafe(node.getExpression())) return;
				[value] = node.getArguments();
			} else {
				return;
			}
			if (value === undefined || isTrustedMarkup(value)) return;
			const line = lineOf(node);
			findings.push({
				check: "xss_html_raw_output",
				line,
				excerpt: excerpt(ctx.sf, line),
			});
		});
		return findings;
	},
};

/** `html.safe` (also reached as `globals.html.safe` and the like). */
function isHtmlSafe(callee: Node): boolean {
	if (!Node.isPropertyAccessExpression(callee)) return false;
	if (callee.getName() !== "safe") return false;
	const owner = callee.getExpression();
	return (
		(Node.isIdentifier(owner) && owner.getText() === "html") ||
		(Node.isPropertyAccessExpression(owner) && owner.getName() === "html")
	);
}

/** Markup the code wrote: a literal, or a template whose values are all escaped. */
function isTrustedMarkup(value: Node): boolean {
	if (
		Node.isStringLiteral(value) ||
		Node.isNoSubstitutionTemplateLiteral(value)
	) {
		return true;
	}
	if (Node.isTemplateExpression(value)) {
		return value
			.getTemplateSpans()
			.every((span) => isEscapeCall(span.getExpression()));
	}
	return isEscapeCall(value);
}

/** `html.escape(...)`. */
function isEscapeCall(node: Node): boolean {
	if (!Node.isCallExpression(node)) return false;
	const callee = node.getExpression();
	if (
		!Node.isPropertyAccessExpression(callee) ||
		callee.getName() !== "escape"
	) {
		return false;
	}
	const owner = callee.getExpression();
	return (
		(Node.isIdentifier(owner) && owner.getText() === "html") ||
		(Node.isPropertyAccessExpression(owner) && owner.getName() === "html")
	);
}
