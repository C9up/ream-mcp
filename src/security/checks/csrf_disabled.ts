/**
 * `csrf_disabled` check (Story 33.7).
 *
 * Flags explicit opt-out of CSRF protection on the @c9up/blackhole
 * security factories. Matches `csrf: false`:
 *
 *     createBlackhole({ csrf: false })
 *     defineConfig({ csrf: false })          // config/blackhole.ts
 *     blackholeExpress({ csrf: false })
 *
 * blackhole ships CSRF on by default; only an intentional disable is
 * a finding. Missing the property entirely is NOT a finding
 * (default-on contract).
 *
 * Recognised callees: `createBlackhole`, `blackholeExpress`,
 * `blackholeFastify`, `defineConfig`.
 */

import { Node, SyntaxKind } from "ts-morph";
import { excerpt, lineOf } from "./_helpers.js";
import type { CheckDefinition, RawFinding } from "./_types.js";

const SHIELD_NAMES = new Set([
	"createBlackhole",
	"blackholeExpress",
	"blackholeFastify",
	"defineConfig",
]);

export const csrfDisabled: CheckDefinition = {
	id: "csrf_disabled",
	severity: "high",
	hint: "remove the `csrf: false` (or `csrf: { enabled: false }`) opt-out from the middleware options; the framework default is on for a reason.",
	docsUrl: "docs:/security/csrf.md",
	run(ctx) {
		const findings: RawFinding[] = [];
		ctx.sf.forEachDescendant((node) => {
			if (!Node.isCallExpression(node) && !Node.isNewExpression(node)) return;
			const callee = node.getExpression();
			const calleeName = Node.isIdentifier(callee)
				? callee.getText()
				: Node.isPropertyAccessExpression(callee)
					? callee.getName()
					: null;
			if (!calleeName || !SHIELD_NAMES.has(calleeName)) return;

			for (const arg of node.getArguments()) {
				if (!Node.isObjectLiteralExpression(arg)) continue;
				const csrfProp = arg.getProperty("csrf");
				if (!csrfProp || !Node.isPropertyAssignment(csrfProp)) continue;
				const init = csrfProp.getInitializer();
				if (!init) continue;

				if (isFalseLiteral(init)) {
					recordFinding(ctx, csrfProp, findings);
					continue;
				}
				// Tolerate a nested `{ enabled: false }` opt-out shape too.
				if (Node.isObjectLiteralExpression(init)) {
					const enabledProp = init.getProperty("enabled");
					if (enabledProp && Node.isPropertyAssignment(enabledProp)) {
						const enabledInit = enabledProp.getInitializer();
						if (enabledInit && isFalseLiteral(enabledInit)) {
							recordFinding(ctx, enabledProp, findings);
						}
					}
				}
			}
		});
		return findings;
	},
};

function isFalseLiteral(node: Node): boolean {
	return node.getKind() === SyntaxKind.FalseKeyword;
}

function recordFinding(
	ctx: import("./_types.js").CheckContext,
	target: Node,
	findings: RawFinding[],
): void {
	const line = lineOf(target);
	findings.push({
		check: "csrf_disabled",
		line,
		excerpt: excerpt(ctx.sf, line),
	});
}
