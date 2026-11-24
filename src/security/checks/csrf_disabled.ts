/**
 * `csrf_disabled` check.
 *
 * Flags a @c9up/blackhole configuration that turns CSRF protection off.
 * blackhole checks CSRF by default (`csrf` absent means on), so only an
 * explicit opt-out is a finding:
 *
 *     export default defineConfig({ csrf: false })            // config/blackhole.ts
 *     defineConfig({ csrf: { enabled: false } })
 *     defineConfig({ csrf: { exceptRoutes: ['/*'] } })         // every path skipped
 *     createBlackhole({ csrf: false })                        // and the Express,
 *     blackholeExpress({ csrf: false })                       // Fastify and Hono
 *                                                             // adapters
 *
 * `defineConfig` is a common name, so it counts only when this file imports
 * it from `@c9up/blackhole` or `@c9up/blackhole/config` (what
 * `ream new --template web` writes). The default export of
 * `config/blackhole.ts` is read as blackhole options too, `defineConfig` or
 * not. Skipping one route (`exceptRoutes: ['/webhooks/*']`) is how blackhole
 * means a webhook to be exempted, and is not flagged; a `*` or `/*` entry,
 * which exempts every path, is.
 *
 * A value the check cannot read (`csrf: settings`, `enabled: env.get(…)`,
 * a spread, a predicate `exceptRoutes`) is not guessed at: it goes to
 * `knownGaps`.
 */

import {
	type ExportAssignment,
	Node,
	type ObjectLiteralExpression,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";
import { excerpt, lineOf } from "./_helpers.js";
import type { CheckContext, CheckDefinition, RawFinding } from "./_types.js";

const BLACKHOLE_FACTORIES = new Set([
	"createBlackhole",
	"blackholeExpress",
	"blackholeFastify",
	"blackholeHono",
]);
/** The modules that export blackhole's `defineConfig`. */
const BLACKHOLE_CONFIG_MODULES = new Set([
	"@c9up/blackhole",
	"@c9up/blackhole/config",
]);
const BLACKHOLE_PACKAGE = "@c9up/blackhole";
const CONFIG_FILE = /(^|\/)config\/blackhole\.tsx?$/;
/** `exceptRoutes` entries that match every path. */
const EVERY_PATH = new Set(["*", "/*"]);

export const csrfDisabled: CheckDefinition = {
	id: "csrf_disabled",
	severity: "high",
	hint: "remove `csrf: false` / `csrf: { enabled: false }` from the blackhole config (`config/blackhole.ts`); to exempt a webhook, list its path in `csrf.exceptRoutes` instead of turning the check off for every route.",
	docsUrl: "https://reamjs.com/en/guides/security/csrf",
	appliesTo(sf, relPath) {
		if (CONFIG_FILE.test(relPath)) return true;
		return sf
			.getImportDeclarations()
			.some((decl) => isBlackholeModule(decl.getModuleSpecifierValue()));
	},
	nothingRead(facts) {
		return facts.dependencies.has(BLACKHOLE_PACKAGE)
			? "csrf_disabled: @c9up/blackhole is a dependency but no blackhole configuration (config/blackhole.ts, defineConfig, createBlackhole or an adapter) was read"
			: null;
	},
	run(ctx) {
		const names = blackholeConfigNames(ctx.sf);
		const findings: RawFinding[] = [];
		const record = (target: Node): void => {
			const line = lineOf(target);
			findings.push({
				check: "csrf_disabled",
				line,
				excerpt: excerpt(ctx.sf, line),
			});
		};
		const unread = (target: Node, what: string): void => {
			ctx.knownGaps.push(
				`csrf_disabled: ${ctx.relPath}:${lineOf(target)}: ${what} is not a literal; whether it turns CSRF off was not checked`,
			);
		};
		const inspected = new Set<ObjectLiteralExpression>();
		const inspect = (options: ObjectLiteralExpression): void => {
			if (inspected.has(options)) return;
			inspected.add(options);
			inspectOptions(options, record, unread);
		};
		ctx.sf.forEachDescendant((node) => {
			if (!Node.isCallExpression(node) && !Node.isNewExpression(node)) return;
			if (!isBlackholeCall(node.getExpression(), names)) return;
			for (const arg of node.getArguments()) {
				if (Node.isObjectLiteralExpression(arg)) inspect(arg);
			}
		});
		if (CONFIG_FILE.test(ctx.relPath)) {
			const options = defaultExportOptions(ctx);
			if (options !== null) inspect(options);
		}
		return findings;
	},
};

function isBlackholeModule(spec: string): boolean {
	return spec === BLACKHOLE_PACKAGE || spec.startsWith(`${BLACKHOLE_PACKAGE}/`);
}

/** Whether `callee` is a blackhole factory or blackhole's `defineConfig`. */
function isBlackholeCall(callee: Node, names: ConfigNames): boolean {
	if (Node.isIdentifier(callee)) {
		const name = callee.getText();
		return BLACKHOLE_FACTORIES.has(name) || names.direct.has(name);
	}
	if (!Node.isPropertyAccessExpression(callee)) return false;
	const name = callee.getName();
	if (BLACKHOLE_FACTORIES.has(name)) return true;
	const owner = callee.getExpression();
	return (
		name === "defineConfig" &&
		Node.isIdentifier(owner) &&
		names.namespaces.has(owner.getText())
	);
}

/**
 * The object literal `config/blackhole.ts` exports by default, unwrapped from
 * `defineConfig(…)`, `satisfies`, `as` and parentheses; `null` when the
 * export is something else (that case is reported in `knownGaps`).
 */
function defaultExportOptions(
	ctx: CheckContext,
): ObjectLiteralExpression | null {
	const assignment: ExportAssignment | undefined = ctx.sf.getExportAssignment(
		(a) => !a.isExportEquals(),
	);
	if (!assignment) return null;
	let expr: Node = assignment.getExpression();
	for (;;) {
		if (
			Node.isSatisfiesExpression(expr) ||
			Node.isAsExpression(expr) ||
			Node.isParenthesizedExpression(expr)
		) {
			expr = expr.getExpression();
			continue;
		}
		break;
	}
	if (Node.isObjectLiteralExpression(expr)) return expr;
	if (Node.isCallExpression(expr)) {
		// A call whose options are read above (defineConfig) or that the
		// check does not know: either way its first literal argument is the config.
		const [first] = expr.getArguments();
		if (first && Node.isObjectLiteralExpression(first)) return first;
	}
	ctx.knownGaps.push(
		`csrf_disabled: ${ctx.relPath}:${lineOf(assignment)}: the default export is not an options object; whether it turns CSRF off was not checked`,
	);
	return null;
}

/** Report the `csrf` option of one options literal when it turns CSRF off. */
function inspectOptions(
	options: ObjectLiteralExpression,
	record: (target: Node) => void,
	unread: (target: Node, what: string) => void,
): void {
	if (options.getProperties().some(Node.isSpreadAssignment)) {
		unread(options, "a spread in the blackhole options");
	}
	const csrfProp = options.getProperty("csrf");
	if (!csrfProp) return;
	if (!Node.isPropertyAssignment(csrfProp)) {
		unread(csrfProp, "`csrf`");
		return;
	}
	const init = csrfProp.getInitializer();
	if (!init) return;
	if (init.getKind() === SyntaxKind.FalseKeyword) {
		record(csrfProp);
		return;
	}
	if (init.getKind() === SyntaxKind.TrueKeyword) return;
	if (!Node.isObjectLiteralExpression(init)) {
		unread(csrfProp, "`csrf`");
		return;
	}
	if (init.getProperties().some(Node.isSpreadAssignment)) {
		unread(init, "a spread in `csrf`");
	}

	const enabled = init.getProperty("enabled");
	if (enabled) {
		const value = Node.isPropertyAssignment(enabled)
			? enabled.getInitializer()
			: undefined;
		if (value?.getKind() === SyntaxKind.FalseKeyword) record(enabled);
		else if (value?.getKind() !== SyntaxKind.TrueKeyword) {
			unread(enabled, "`csrf.enabled`");
		}
	}

	const except = init.getProperty("exceptRoutes");
	if (!except) return;
	const routes = Node.isPropertyAssignment(except)
		? except.getInitializer()
		: undefined;
	if (!routes || !Node.isArrayLiteralExpression(routes)) {
		unread(except, "`csrf.exceptRoutes`");
		return;
	}
	let everyPath = false;
	for (const el of routes.getElements()) {
		if (Node.isStringLiteral(el) || Node.isNoSubstitutionTemplateLiteral(el)) {
			if (EVERY_PATH.has(el.getLiteralValue())) everyPath = true;
			continue;
		}
		unread(el, "a `csrf.exceptRoutes` entry");
	}
	if (everyPath) record(except);
}

interface ConfigNames {
	/** Local names bound to blackhole's `defineConfig`. */
	direct: Set<string>;
	/** Namespace imports of a blackhole config module (`bh.defineConfig`). */
	namespaces: Set<string>;
}

/** The local names this file gives blackhole's `defineConfig`. */
function blackholeConfigNames(sf: SourceFile): ConfigNames {
	const names: ConfigNames = { direct: new Set(), namespaces: new Set() };
	for (const decl of sf.getImportDeclarations()) {
		if (!BLACKHOLE_CONFIG_MODULES.has(decl.getModuleSpecifierValue())) continue;
		const namespace = decl.getNamespaceImport();
		if (namespace) names.namespaces.add(namespace.getText());
		for (const named of decl.getNamedImports()) {
			if (named.getName() === "defineConfig") {
				names.direct.add(named.getAliasNode()?.getText() ?? "defineConfig");
			}
		}
	}
	return names;
}
