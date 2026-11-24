/**
 * `missing_guard_on_mutation_route` check.
 *
 * Flags a state-changing route that nothing authenticates. A Ream
 * application declares its routes on the router (`start/routes.ts`, or a
 * module's `routes.ts`):
 *
 *     router.post('/posts', [PostsController, 'store'])
 *     router.delete('/posts/:id', 'PostsController.destroy')
 *     router.resource('posts', PostsController)
 *
 * A mutating route is `post`, `put`, `patch`, `delete`, `any`, a
 * `route(pattern, methods, handler)` whose methods include one of those, and
 * the `store` / `update` / `destroy` actions of a `resource` /
 * `shallowResource` that `only` / `except` keep. It is protected when one of
 * these holds:
 *
 *   - the route's chain calls `.guard()`, `.role()` or `.permission()` with
 *     at least one name. A call that names nothing protects nothing: ream
 *     refuses it at declaration from 0.2.32 (`E_EMPTY_GATE_REQUIREMENT`), and
 *     before that it added no requirement;
 *   - the route's chain attaches the auth middleware by name:
 *     `.middleware('auth')`, `.use(middleware.auth())`, or a lazy import of
 *     a file named `auth_middleware`. The name is matched, not a substring
 *     (`authorAudit` is not the auth middleware); on a resource,
 *     `.use(actions, …)` / `.middleware(actions, …)` covering the action, or
 *     a `.tap()` whose callback does one of the above;
 *   - an enclosing `router.group(() => …)` chains one of the above, or a
 *     `router.group({ guards, roles, permissions, middleware }, …)` config
 *     names them in a literal list;
 *   - the controller action carries warden's `@Guard`, `@Role` or
 *     `@Permission` with at least one name, or `@RequireMfa()`, which ream's
 *     route gate enforces from 0.2.32 (an anonymous request gets 401). The
 *     decorators are looked up the way warden reads them: through the
 *     `extends` chain, an undecorated override inheriting the parent's.
 *
 * What the check cannot read is not guessed at: a controller it cannot
 * follow (a package import, a computed handler), a gate or group list that
 * is not a literal (`.guard(...names)`, `{ guards: configured }`), a lone
 * `@RequireMfa()` when the ream version is unknown. The route is reported in
 * `knownGaps`, not as a finding. A route left public on purpose (login, a
 * signed webhook) is still a finding; the hint says so.
 *
 * Router-level middleware (`router.use([...])`, `server.use([...])`) is not
 * read: Ream's silent auth and Adonis-style initialisers run there, and
 * they authenticate without refusing anyone.
 */

import {
	type CallExpression,
	type ClassDeclaration,
	type Decorator,
	Node,
	type NoSubstitutionTemplateLiteral,
	type SourceFile,
	type StringLiteral,
	SyntaxKind,
} from "ts-morph";
import { excerpt, lineOf } from "./_helpers.js";
import {
	classOfModule,
	dynamicImportSpecifier,
	resolveClass,
} from "./_modules.js";
import { REAM_SECURE_DEFAULTS, reamAtLeast } from "./_project.js";
import type { CheckContext, CheckDefinition, RawFinding } from "./_types.js";

const MUTATING_VERBS = new Set(["post", "put", "patch", "delete"]);
const ROUTE_GATES = new Set(["guard", "role", "permission"]);
const MIDDLEWARE_METHODS = new Set(["middleware", "use"]);
/** warden's decorators that name a requirement (and need one name at least). */
const WARDEN_GATE_DECORATORS = new Set(["Guard", "Role", "Permission"]);
const REQUIRE_MFA = "RequireMfa";
const RESOURCE_METHODS = new Set(["resource", "shallowResource"]);
const MUTATING_ACTIONS = ["store", "update", "destroy"] as const;
const ROUTER_MODULE = "@c9up/ream/services/router";
/** How deep an `extends` chain is followed before giving up. */
const MAX_INHERITANCE = 8;

/** The name the auth middleware is registered under (`router.named({ auth })`). */
const AUTH_MIDDLEWARE_NAME = "auth";
/** A module specifier naming the auth middleware file (`#middleware/auth_middleware.js`). */
const AUTH_MIDDLEWARE_FILE =
	/(^|\/)(auth_middleware|AuthMiddleware)(\.[cm]?[jt]s)?$/;
/** Methods whose text names a router method, so a file calling them declares routes. */
const ROUTER_METHODS = new Set([
	"get",
	"post",
	"put",
	"patch",
	"delete",
	"any",
	"route",
	"resource",
	"shallowResource",
	"group",
	"on",
]);

type Protection = "protected" | "unprotected" | { unresolved: string };

export const missingGuardOnMutationRoute: CheckDefinition = {
	id: "missing_guard_on_mutation_route",
	severity: "high",
	hint: "protect the route: chain `.guard('web')` on it or on its `router.group()` (with `.role('admin')` / `.permission('posts.delete')` when it needs them), attach the auth middleware by name (`.middleware('auth')`), or decorate the controller action with `@Guard('web')`, `@Role(…)` or `@Permission(…)` from `@c9up/warden`. Each gate must name something: `.guard()` with no name protects nothing (ream refuses it at boot from 0.2.32). A route that is public on purpose (login, a signed webhook) can stay as it is.",
	docsUrl: "https://reamjs.com/en/guides/auth/protecting-routes",
	appliesTo(sf) {
		if (
			sf
				.getImportDeclarations()
				.some((decl) => decl.getModuleSpecifierValue() === ROUTER_MODULE)
		) {
			return true;
		}
		const routers = routerNames(sf);
		return sf.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
			const callee = call.getExpression();
			return (
				Node.isPropertyAccessExpression(callee) &&
				ROUTER_METHODS.has(callee.getName()) &&
				isRouter(callee.getExpression(), routers)
			);
		});
	},
	nothingRead() {
		return "missing_guard_on_mutation_route: no file declaring routes was read (start/routes.ts, a module's routes.ts, or a file importing @c9up/ream/services/router)";
	},
	run(ctx) {
		const routers = routerNames(ctx.sf);
		const findings: RawFinding[] = [];
		ctx.sf.forEachDescendant((node) => {
			if (!Node.isCallExpression(node)) return;
			const callee = node.getExpression();
			if (!Node.isPropertyAccessExpression(callee)) return;
			if (!isRouter(callee.getExpression(), routers)) return;
			const verdict = judgeRoute(ctx, node, callee.getName());
			if (verdict === null || verdict === "protected") return;
			const line = lineOf(node);
			if (verdict === "unprotected") {
				findings.push({
					check: "missing_guard_on_mutation_route",
					line,
					excerpt: excerpt(ctx.sf, line),
				});
				return;
			}
			ctx.knownGaps.push(
				`missing_guard_on_mutation_route: ${ctx.relPath}:${line}: not decided (${verdict.unresolved})`,
			);
		});
		return findings;
	},
};

/**
 * The verdict on one router call, or `null` when it does not declare a
 * mutating route.
 */
function judgeRoute(
	ctx: CheckContext,
	call: CallExpression,
	method: string,
): Protection | null {
	const args = call.getArguments();
	if (RESOURCE_METHODS.has(method)) return judgeResource(ctx, call);
	let handler: Node | undefined;
	if (MUTATING_VERBS.has(method) || method === "any") {
		handler = args[1];
	} else if (method === "route") {
		const methods = args[1];
		if (!methods || !declaresMutatingVerb(methods)) return null;
		handler = args[2];
	} else {
		return null;
	}
	const own = combine(chainProtection(call), groupProtection(call));
	if (own === "protected") return own;
	return combine(
		own,
		handler ? handlerProtection(ctx, handler) : "unprotected",
	);
}

/** Protected when either is; otherwise undecided when either is; otherwise unprotected. */
function combine(a: Protection, b: Protection): Protection {
	if (a === "protected" || b === "protected") return "protected";
	if (a !== "unprotected") return a;
	return b;
}

/** Whether `route(pattern, methods, …)`'s methods include a mutating verb (unknown counts as one). */
function declaresMutatingVerb(methods: Node): boolean {
	const literals = Node.isArrayLiteralExpression(methods)
		? methods.getElements()
		: [methods];
	for (const el of literals) {
		if (
			!Node.isStringLiteral(el) &&
			!Node.isNoSubstitutionTemplateLiteral(el)
		) {
			return true;
		}
		const verb = el.getLiteralValue().toLowerCase();
		if (MUTATING_VERBS.has(verb) || verb === "*") return true;
	}
	return false;
}

// ------------------------------------------------------------ handlers

/** The protection a route handler carries by itself (warden decorators). */
function handlerProtection(ctx: CheckContext, handler: Node): Protection {
	// Inline closure: nothing to decorate.
	if (Node.isArrowFunction(handler) || Node.isFunctionExpression(handler)) {
		return "unprotected";
	}
	if (Node.isArrayLiteralExpression(handler)) {
		const [target, action] = handler.getElements();
		if (!target || !action || !isStringLiteral(action)) {
			return { unresolved: "the handler is not a [Controller, 'action'] pair" };
		}
		const cls = controllerClass(ctx, target);
		if ("unresolved" in cls) return cls;
		return actionProtection(ctx, cls.found, action.getLiteralValue());
	}
	if (isStringLiteral(handler)) {
		// 'UsersController.store', registered with router.controllers({ … }).
		const [name, action] = handler.getLiteralValue().split(".");
		if (!name || !action) {
			return {
				unresolved: `the handler '${handler.getLiteralValue()}' is not 'Controller.action'`,
			};
		}
		const spec = registeredController(ctx.sf, name);
		if (spec === null) {
			return {
				unresolved: `'${name}' is not registered with router.controllers()`,
			};
		}
		const lookup = classOfModule(
			ctx.project,
			ctx.root,
			ctx.sf,
			spec,
			"default",
		);
		if (lookup.kind !== "found") return { unresolved: lookup.reason };
		return actionProtection(ctx, lookup.cls, action);
	}
	return { unresolved: "the handler is computed" };
}

function isStringLiteral(
	node: Node,
): node is StringLiteral | NoSubstitutionTemplateLiteral {
	return (
		Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)
	);
}

function controllerClass(
	ctx: CheckContext,
	target: Node,
): { found: ClassDeclaration } | { unresolved: string } {
	if (!Node.isIdentifier(target)) {
		return { unresolved: "the controller is not a plain identifier" };
	}
	const lookup = resolveClass(ctx.project, ctx.root, ctx.sf, target.getText());
	return lookup.kind === "found"
		? { found: lookup.cls }
		: { unresolved: lookup.reason };
}

/** The lazy import `router.controllers({ name: () => import('spec') })` registers for `name`. */
function registeredController(sf: SourceFile, name: string): string | null {
	let spec: string | null = null;
	sf.forEachDescendant((node, traversal) => {
		if (!Node.isCallExpression(node)) return;
		const callee = node.getExpression();
		if (!Node.isPropertyAccessExpression(callee)) return;
		if (callee.getName() !== "controllers") return;
		const [map] = node.getArguments();
		if (!map || !Node.isObjectLiteralExpression(map)) return;
		const prop = map.getProperty(name);
		if (!prop || !Node.isPropertyAssignment(prop)) return;
		const init = prop.getInitializer();
		spec = init ? dynamicImportSpecifier(init) : null;
		if (spec !== null) traversal.stop();
	});
	return spec;
}

/** Whether `action` carries a warden decorator, read through `extends` as warden reads it. */
function actionProtection(
	ctx: CheckContext,
	start: ClassDeclaration,
	action: string,
): Protection {
	let cls: ClassDeclaration | undefined = start;
	for (let depth = 0; cls && depth < MAX_INHERITANCE; depth++) {
		const method = cls.getMethod(action);
		if (method) {
			let verdict: Protection = "unprotected";
			for (const dec of method.getDecorators()) {
				verdict = combine(verdict, decoratorProtection(ctx, dec));
			}
			// The override's own decorators decide when it has any; warden
			// reads the metadata of the nearest prototype that declares it.
			if (verdict !== "unprotected") return verdict;
		}
		const parent = cls.getExtends()?.getExpression();
		if (!parent) return "unprotected";
		if (!Node.isIdentifier(parent)) {
			return {
				unresolved: `${cls.getName() ?? "the controller"} extends a computed class`,
			};
		}
		const lookup = resolveClass(
			ctx.project,
			ctx.root,
			cls.getSourceFile(),
			parent.getText(),
		);
		if (lookup.kind !== "found") return { unresolved: lookup.reason };
		cls = lookup.cls;
	}
	return { unresolved: "the extends chain is too deep" };
}

function decoratorProtection(ctx: CheckContext, dec: Decorator): Protection {
	const name = dec.getName();
	if (WARDEN_GATE_DECORATORS.has(name)) {
		return namesProtection(dec.getArguments(), `@${name}()`);
	}
	if (name !== REQUIRE_MFA) return "unprotected";
	const enforced = reamAtLeast(ctx.facts, REAM_SECURE_DEFAULTS);
	if (enforced === true) return "protected";
	if (enforced === false) return "unprotected";
	return {
		unresolved: `@RequireMfa() alone is enforced by ream's route gate from ${REAM_SECURE_DEFAULTS.join(".")}, and the application's ream version was not found`,
	};
}

/**
 * What a gate's arguments require: a name makes it a protection, nothing
 * (or only empty strings) leaves it none, and a spread of a list the check
 * cannot read is undecided.
 */
function namesProtection(args: readonly Node[], call: string): Protection {
	let spread = false;
	for (const arg of args) {
		if (Node.isSpreadElement(arg)) {
			const list = arg.getExpression();
			if (Node.isArrayLiteralExpression(list)) {
				if (namesProtection(list.getElements(), call) === "protected") {
					return "protected";
				}
				continue;
			}
			spread = true;
			continue;
		}
		if (isStringLiteral(arg) && arg.getLiteralValue() === "") continue;
		return "protected";
	}
	return spread
		? { unresolved: `${call} spreads a list that is not a literal` }
		: "unprotected";
}

// ------------------------------------------------------------ chains

/**
 * The calls chained on `call`, outermost last:
 * `router.post(…).guard('web').as('x')` gives `guard`, then `as`.
 */
function chainOf(call: CallExpression): CallExpression[] {
	const chain: CallExpression[] = [];
	let current: Node = call;
	for (;;) {
		const access = current.getParent();
		if (!access || !Node.isPropertyAccessExpression(access)) break;
		if (access.getExpression() !== current) break;
		const next = access.getParent();
		if (
			!next ||
			!Node.isCallExpression(next) ||
			next.getExpression() !== access
		) {
			break;
		}
		chain.push(next);
		current = next;
	}
	return chain;
}

function chainedName(call: CallExpression): string {
	const callee = call.getExpression();
	return Node.isPropertyAccessExpression(callee) ? callee.getName() : "";
}

/** What a route or group chain requires of its routes. */
function chainProtection(call: CallExpression): Protection {
	let verdict: Protection = "unprotected";
	for (const link of chainOf(call))
		verdict = combine(verdict, linkProtection(link));
	return verdict;
}

/** What one chained call (`.guard('web')`, `.use(middleware.auth())`) requires. */
function linkProtection(link: CallExpression): Protection {
	const name = chainedName(link);
	if (ROUTE_GATES.has(name)) {
		return namesProtection(link.getArguments(), `.${name}()`);
	}
	if (MIDDLEWARE_METHODS.has(name)) {
		return link.getArguments().some(namesAuthMiddleware)
			? "protected"
			: "unprotected";
	}
	return "unprotected";
}

/**
 * Whether `node` names the auth middleware: the name `'auth'`,
 * `middleware.auth(…)` / `middleware.auth`, a lazy import of a file named
 * `auth_middleware`, or a list holding one of them.
 */
function namesAuthMiddleware(node: Node): boolean {
	if (isStringLiteral(node)) {
		return node.getLiteralValue() === AUTH_MIDDLEWARE_NAME;
	}
	if (Node.isArrayLiteralExpression(node)) {
		return node.getElements().some(namesAuthMiddleware);
	}
	const target = Node.isCallExpression(node) ? node.getExpression() : node;
	if (
		Node.isPropertyAccessExpression(target) &&
		target.getName() === AUTH_MIDDLEWARE_NAME &&
		Node.isIdentifier(target.getExpression())
	) {
		return true;
	}
	const spec = dynamicImportSpecifier(node);
	return spec !== null && AUTH_MIDDLEWARE_FILE.test(spec);
}

/** What the `router.group(…)` calls around `call` require of it. */
function groupProtection(call: CallExpression): Protection {
	let verdict: Protection = "unprotected";
	for (const fn of call.getAncestors()) {
		if (!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn)) continue;
		const group = fn.getParent();
		if (!group || !Node.isCallExpression(group)) continue;
		if (chainedName(group) !== "group") continue;
		verdict = combine(verdict, chainProtection(group));
		const [config] = group.getArguments();
		if (config && config !== fn) {
			verdict = combine(verdict, configProtection(config));
		}
		if (verdict === "protected") return verdict;
	}
	return verdict;
}

/** The `router.group({ guards, roles, permissions, middleware }, cb)` config. */
function configProtection(config: Node): Protection {
	if (!Node.isObjectLiteralExpression(config)) {
		return { unresolved: "the group config is not an object literal" };
	}
	let verdict: Protection = config.getProperties().some(Node.isSpreadAssignment)
		? { unresolved: "the group config spreads an object" }
		: "unprotected";
	for (const key of ["guards", "roles", "permissions", "middleware"]) {
		const prop = config.getProperty(key);
		if (!prop) continue;
		const init = Node.isPropertyAssignment(prop)
			? prop.getInitializer()
			: undefined;
		if (!init || !Node.isArrayLiteralExpression(init)) {
			verdict = combine(verdict, {
				unresolved: `the group's \`${key}\` is not a literal list`,
			});
			continue;
		}
		if (key === "middleware") {
			const elements = init.getElements();
			if (elements.some(namesAuthMiddleware)) return "protected";
			if (elements.some((el) => !isStringLiteral(el))) {
				verdict = combine(verdict, {
					unresolved:
						"the group's `middleware` holds a name that is not a literal",
				});
			}
			continue;
		}
		verdict = combine(
			verdict,
			namesProtection(init.getElements(), `group { ${key} }`),
		);
	}
	return verdict;
}

// ------------------------------------------------------------ resources

function judgeResource(ctx: CheckContext, call: CallExpression): Protection {
	const group = groupProtection(call);
	if (group === "protected") return group;
	const chain = chainOf(call);
	let actions: string[] = [...MUTATING_ACTIONS];
	const covered = new Set<string>();
	let undecided: Protection = "unprotected";
	const cover = (verdict: Protection, names: readonly string[]): void => {
		if (verdict === "protected") for (const a of names) covered.add(a);
		else undecided = combine(undecided, verdict);
	};
	for (const link of chain) {
		const name = chainedName(link);
		const [first, second] = link.getArguments();
		if (name === "only" && first) {
			const kept = literalActions(first);
			if (kept !== null) actions = actions.filter((a) => kept.includes(a));
		} else if (name === "except" && first) {
			const dropped = literalActions(first);
			if (dropped !== null)
				actions = actions.filter((a) => !dropped.includes(a));
		} else if (MIDDLEWARE_METHODS.has(name) && first && second) {
			if (namesAuthMiddleware(second)) cover("protected", actionsOf(first));
		} else if (name === "tap" && first) {
			const callback = second ?? first;
			cover(tapProtection(callback), second ? actionsOf(first) : ["*"]);
		}
	}
	const open = actions.filter((a) => !covered.has(a) && !covered.has("*"));
	if (open.length === 0) return "protected";

	const [, controller] = call.getArguments();
	if (!controller) return combine(group, undecided);
	const cls = controllerClass(ctx, controller);
	if ("unresolved" in cls) return cls;
	for (const action of open) {
		const verdict = combine(
			combine(group, undecided),
			actionProtection(ctx, cls.found, action),
		);
		if (verdict !== "protected") return verdict;
	}
	return "protected";
}

/** What a resource's `.tap((route) => route.guard('web'))` callback requires. */
function tapProtection(callback: Node): Protection {
	let verdict: Protection = "unprotected";
	for (const call of callback.getDescendantsOfKind(SyntaxKind.CallExpression)) {
		verdict = combine(verdict, linkProtection(call));
	}
	return verdict;
}

/** The action names of an `only([...])` / `except([...])` literal, or `null` when not literal. */
function literalActions(node: Node): string[] | null {
	const elements = Node.isArrayLiteralExpression(node)
		? node.getElements()
		: [node];
	const names: string[] = [];
	for (const el of elements) {
		if (!isStringLiteral(el)) return null;
		names.push(el.getLiteralValue());
	}
	return names;
}

/** The actions a resource's `.use(actions, …)` names; `'*'` for all, or anything not literal. */
function actionsOf(node: Node): string[] {
	return literalActions(node) ?? ["*"];
}

// ------------------------------------------------------------ router

/** The local names the router service is bound to in this file. */
function routerNames(sf: SourceFile): Set<string> {
	const names = new Set(["router"]);
	for (const decl of sf.getImportDeclarations()) {
		if (decl.getModuleSpecifierValue() !== ROUTER_MODULE) continue;
		const local = decl.getDefaultImport()?.getText();
		if (local) names.add(local);
	}
	return names;
}

/**
 * Whether `expr` is the router: a name bound to it, or the parameter of a
 * `router.group(config, (r) => …)` callback.
 */
function isRouter(expr: Node, routers: Set<string>): boolean {
	if (!Node.isIdentifier(expr)) return false;
	const name = expr.getText();
	if (routers.has(name)) return true;
	for (const fn of expr.getAncestors()) {
		if (!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn)) continue;
		const group = fn.getParent();
		if (
			!group ||
			!Node.isCallExpression(group) ||
			chainedName(group) !== "group"
		) {
			continue;
		}
		if (fn.getParameters().some((p) => p.getName() === name)) return true;
	}
	return false;
}
