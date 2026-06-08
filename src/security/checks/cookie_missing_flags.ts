/**
 * `cookie_missing_flags` check (Story 33.7).
 *
 * Flags `cookie(...)` set calls that omit `secure` or `sameSite`,
 * or that explicitly set `httpOnly: false`.
 *
 *     res.cookie("session", token, { maxAge: 3600 });   // missing secure + sameSite
 *     res.cookie("session", token, { httpOnly: false }); // explicit downgrade
 *
 * `httpOnly` is intentionally NOT required-when-missing: Ream's
 * `response.cookie` (`packages/ream/src/http/Response.ts:155`)
 * defaults `httpOnly: true` unless explicitly set to `false`,
 * and most modern HTTP frameworks follow the same convention.
 * We only fire when the caller has actively downgraded it.
 *
 * Detected method names: `cookie`, `set` (when on a `cookies`
 * property), `setCookie`. Calls whose options literal includes a
 * spread (`{ ...defaults, maxAge: 1 }`) are skipped — the spread
 * may carry the missing flags and we cannot resolve it
 * statically (false-negative tolerated to avoid false-positives).
 */

import { Node, SyntaxKind } from "ts-morph";
import { excerpt, lineOf } from "./_helpers.js";
import type { CheckDefinition, RawFinding } from "./_types.js";

const REQUIRED_FLAGS = ["secure", "sameSite"] as const;

export const cookieMissingFlags: CheckDefinition = {
	id: "cookie_missing_flags",
	severity: "low",
	hint: "set `secure: true` and `sameSite: 'lax'` (or stricter) on every cookie write; explicit `httpOnly: false` should also be removed.",
	docsUrl: "docs:/security/cookies.md",
	run(ctx) {
		const findings: RawFinding[] = [];
		ctx.sf.forEachDescendant((node) => {
			if (!Node.isCallExpression(node)) return;
			const expr = node.getExpression();
			if (!Node.isPropertyAccessExpression(expr)) return;
			const methodName = expr.getName();
			const objText = expr.getExpression().getText();
			const isCookieSet =
				methodName === "cookie" ||
				methodName === "setCookie" ||
				(methodName === "set" && /cookies?$/i.test(objText));
			if (!isCookieSet) return;

			const args = node.getArguments();
			const opts = args.find((a) => Node.isObjectLiteralExpression(a));
			if (!opts || !Node.isObjectLiteralExpression(opts)) {
				const line = lineOf(node);
				findings.push({
					check: "cookie_missing_flags",
					line,
					excerpt: excerpt(ctx.sf, line),
				});
				return;
			}

			// A spread element could supply any of the flags via a
			// runtime-resolved object — bail out rather than emit
			// a false positive.
			const hasSpread = opts
				.getProperties()
				.some((p) => p.getKind() === SyntaxKind.SpreadAssignment);
			if (hasSpread) return;

			const assignments = opts
				.getProperties()
				.filter(Node.isPropertyAssignment);
			const present = new Set(assignments.map((p) => p.getName()));
			const missingRequired = REQUIRED_FLAGS.some((f) => !present.has(f));

			// Explicit `httpOnly: false` is a downgrade and always
			// flagged, regardless of the other flags.
			const httpOnlyProp = assignments.find((p) => p.getName() === "httpOnly");
			const httpOnlyDowngrade =
				httpOnlyProp !== undefined &&
				httpOnlyProp.getInitializer()?.getKind() === SyntaxKind.FalseKeyword;

			if (missingRequired || httpOnlyDowngrade) {
				const line = lineOf(node);
				findings.push({
					check: "cookie_missing_flags",
					line,
					excerpt: excerpt(ctx.sf, line),
				});
			}
		});
		return findings;
	},
};
