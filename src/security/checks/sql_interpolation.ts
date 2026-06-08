/**
 * `sql_interpolation` check (Story 33.7).
 *
 * Flags template-literal interpolation passed to a query method
 * or to a `sql\`\`` tagged template (the Prisma / postgres.js /
 * slonik / drizzle pattern):
 *
 *     db.query(`SELECT * FROM users WHERE id = ${userId}`);
 *     db.unsafe`SELECT * FROM users WHERE id = ${userId}`;
 *     sql.unsafe`SELECT * FROM users WHERE id = ${userId}`;
 *
 * which bypasses the prepared-statement placeholder contract and
 * lets caller-controlled strings reach the SQL engine raw. The
 * canonical fix is documented in
 * `docs:/security/sql-injection.md`.
 *
 * Heuristics, in priority order:
 *   1. `CallExpression` whose callee is a property access of
 *      `query` / `execute` / `raw` / `unsafe`, with at least one
 *      argument that is a `TemplateExpression` carrying ≥ 1
 *      template span (`${...}`).
 *   2. String concatenation (`'... ' + x`) inside the same call.
 *   3. `TaggedTemplateExpression` whose tag matches one of the
 *      known unsafe tags (`sql.unsafe`, `unsafeSql`, `db.unsafe`).
 *      The plain `sql\`\`` tag is NOT flagged — most ORMs treat
 *      it as a safe parameterising tag (Prisma, postgres.js).
 *
 * Deliberate non-goals: no taint tracking. We do not follow
 * `let q = \`... ${x}\`; db.query(q)` through assignment chains
 * (story scope cut).
 */

import { Node } from "ts-morph";
import { excerpt, lineOf } from "./_helpers.js";
import type { CheckDefinition, RawFinding } from "./_types.js";

const QUERY_METHODS = new Set(["query", "execute", "raw", "unsafe"]);
// Tags that indicate raw / unparameterised SQL even when wrapped
// as a tagged template. Plain `sql\`\`` is intentionally NOT in
// this set — Prisma / postgres.js / slonik treat it as the safe
// parameterising tag.
const UNSAFE_SQL_TAGS = new Set(["unsafe", "unsafeSql", "rawSql"]);

export const sqlInterpolation: CheckDefinition = {
	id: "sql_interpolation",
	severity: "high",
	hint: "use prepared-statement placeholders (?, $1, :name) and pass the dynamic value as a bound parameter instead of interpolating it into the SQL string.",
	docsUrl: "docs:/security/sql-injection.md",
	run(ctx) {
		const findings: RawFinding[] = [];
		ctx.sf.forEachDescendant((node) => {
			if (Node.isTaggedTemplateExpression(node)) {
				if (isUnsafeSqlTag(node) && hasInterpolation(node.getTemplate())) {
					findings.push(rawFinding(ctx, node));
				}
				return;
			}
			if (!Node.isCallExpression(node)) return;
			const expr = node.getExpression();
			// Accept both eager (`db.query(...)`) and optional-chained
			// (`db?.query(...)`) call shapes — ts-morph models the
			// latter as PropertyAccessExpression with an optional-chain
			// flag, surfaced via the same `getName()`.
			if (
				!Node.isPropertyAccessExpression(expr) &&
				!Node.isElementAccessExpression(expr)
			) {
				return;
			}
			const methodName = Node.isPropertyAccessExpression(expr)
				? expr.getName()
				: extractStringIndex(expr);
			if (!methodName || !QUERY_METHODS.has(methodName)) return;

			for (const arg of node.getArguments()) {
				if (Node.isTemplateExpression(arg)) {
					if (arg.getTemplateSpans().length > 0) {
						findings.push(rawFinding(ctx, node));
						return;
					}
				}
				if (Node.isBinaryExpression(arg) && containsIdentifierConcat(arg)) {
					findings.push(rawFinding(ctx, node));
					return;
				}
			}
		});
		return findings;
	},
};

function containsIdentifierConcat(node: Node): boolean {
	if (!Node.isBinaryExpression(node)) return false;
	const op = node.getOperatorToken().getText();
	if (op !== "+") return false;
	const left = node.getLeft();
	const right = node.getRight();
	const hasString =
		Node.isStringLiteral(left) ||
		Node.isStringLiteral(right) ||
		Node.isNoSubstitutionTemplateLiteral(left) ||
		Node.isNoSubstitutionTemplateLiteral(right);
	const hasIdent =
		Node.isIdentifier(left) ||
		Node.isIdentifier(right) ||
		Node.isPropertyAccessExpression(left) ||
		Node.isPropertyAccessExpression(right);
	if (hasString && hasIdent) return true;
	return containsIdentifierConcat(left) || containsIdentifierConcat(right);
}

function rawFinding(
	ctx: import("./_types.js").CheckContext,
	node: Node,
): RawFinding {
	const line = lineOf(node);
	return {
		check: "sql_interpolation",
		line,
		excerpt: excerpt(ctx.sf, line),
	};
}

function isUnsafeSqlTag(
	node: import("ts-morph").TaggedTemplateExpression,
): boolean {
	const tag = node.getTag();
	if (Node.isIdentifier(tag)) {
		return UNSAFE_SQL_TAGS.has(tag.getText());
	}
	if (Node.isPropertyAccessExpression(tag)) {
		return UNSAFE_SQL_TAGS.has(tag.getName());
	}
	return false;
}

function hasInterpolation(tpl: import("ts-morph").TemplateLiteral): boolean {
	return Node.isTemplateExpression(tpl) && tpl.getTemplateSpans().length > 0;
}

function extractStringIndex(
	expr: import("ts-morph").ElementAccessExpression,
): string | null {
	const arg = expr.getArgumentExpression();
	if (!arg) return null;
	if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) {
		return arg.getLiteralText();
	}
	return null;
}
