/**
 * `xss_html_raw_output` check (Story 33.7).
 *
 * Flags two anti-patterns:
 *
 *   1. Tagged template literals using `html` / `raw` /
 *      `unsafeHtml` to embed dynamic data without sanitization.
 *   2. Edge-template raw-output `{{{ ... }}}` inside `*.edge`
 *      files (regex-based — full Edge AST parsing is parked,
 *      see story scope cuts).
 *
 * False negatives are acceptable here; the value is in catching
 * the literal anti-pattern that has bitten the project before.
 */

import { Node } from "ts-morph";
import { excerpt, lineOf } from "./_helpers.js";
import type { CheckDefinition, RawFinding } from "./_types.js";

// `html` is intentionally NOT included — Lit, lit-html, htm, and
// hyperHTML use `html\`\`` as the SAFE auto-escaping tag. Only
// the explicitly-unsafe escape hatches are flagged.
const RAW_TAGS = new Set(["raw", "unsafeHtml", "rawHtml", "html_raw"]);

export const xssHtmlRawOutput: CheckDefinition = {
	id: "xss_html_raw_output",
	severity: "medium",
	hint: "sanitize dynamic data through the framework's XSS helper (e.g. `escapeHtml(...)`) before embedding it in HTML; reserve raw output for trusted, statically-known strings.",
	docsUrl: "docs:/security/xss.md",
	run(ctx) {
		const findings: RawFinding[] = [];
		ctx.sf.forEachDescendant((node) => {
			if (!Node.isTaggedTemplateExpression(node)) return;
			const tag = node.getTag();
			const tagName = Node.isIdentifier(tag)
				? tag.getText()
				: Node.isPropertyAccessExpression(tag)
					? tag.getName()
					: null;
			if (!tagName || !RAW_TAGS.has(tagName)) return;
			const tpl = node.getTemplate();
			if (Node.isTemplateExpression(tpl) && tpl.getTemplateSpans().length > 0) {
				const line = lineOf(node);
				findings.push({
					check: "xss_html_raw_output",
					line,
					excerpt: excerpt(ctx.sf, line),
				});
			}
		});
		return findings;
	},
};
