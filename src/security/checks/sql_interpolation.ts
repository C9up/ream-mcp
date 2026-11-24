/**
 * `sql_interpolation` check.
 *
 * Flags a value interpolated into the SQL text of one of atlas's raw-SQL
 * entry points, instead of passed as a binding:
 *
 *     db.rawQuery(`select * from users where id = ${id}`)
 *     User.query().whereRaw(`price > ${min}`)
 *     db.execute('delete from sessions where user_id = ' + userId)
 *     this.schema.raw(`create index on ${table} (email)`)
 *
 * The text reaches the database as SQL, so a caller-controlled string
 * becomes SQL. atlas takes the values as bindings
 * (`db.rawQuery('… where id = ?', [id])`, `whereRaw('price > ?', [min])`,
 * `??` for an identifier).
 *
 * Methods: `rawQuery`, `raw`, `execute`, `query` (the connection's
 * `query(sql, params)`), and every `*Raw` builder method (`whereRaw`,
 * `orWhereRaw`, `whereNotRaw`, `havingRaw`, `orderByRaw`, `groupByRaw`,
 * `joinRaw`, …). A call is flagged when one of its arguments is a template
 * literal with a `${…}` or a string concatenated with a name.
 *
 * Deliberate non-goals: no taint tracking. We do not follow
 * `let q = \`... ${x}\`; db.rawQuery(q)` through assignment chains.
 */

import { Node } from "ts-morph";
import { excerpt, lineOf } from "./_helpers.js";
import type { CheckDefinition, RawFinding } from "./_types.js";

const QUERY_METHODS = new Set(["rawQuery", "raw", "execute", "query"]);
/** atlas's raw builder methods: `whereRaw`, `orHavingRaw`, `joinRaw`… */
const RAW_BUILDER_METHOD = /^[a-z][A-Za-z]*Raw$/;

export const sqlInterpolation: CheckDefinition = {
	id: "sql_interpolation",
	severity: "high",
	hint: "pass the value as a binding instead of writing it into the SQL: `db.rawQuery('select * from users where id = ?', [id])`, `whereRaw('price > ?', [min])`, `??` for an identifier; or use the query builder (`where`, `whereExpr`).",
	docsUrl: "https://reamjs.com/en/guides/database/orm/security#raw-sql-rules",
	run(ctx) {
		const findings: RawFinding[] = [];
		ctx.sf.forEachDescendant((node) => {
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
			if (
				!methodName ||
				(!QUERY_METHODS.has(methodName) && !RAW_BUILDER_METHOD.test(methodName))
			) {
				return;
			}

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
