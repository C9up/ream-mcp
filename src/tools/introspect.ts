/**
 * `introspect.*` MCP tools — Story 33.3.
 *
 * Six read-only tools that walk the user's TS source via ts-morph
 * (no type checker). Decorator + call matching is by leaf name —
 * `@Entity` matches whether imported from `@c9up/atlas` or
 * re-exported through `@c9up/ream`.
 *
 * Every handler returns a structured `{ error, hint }` object on
 * misconfiguration rather than throwing. The handlers themselves
 * may throw on missing required args (loud-on-misuse) — that path
 * surfaces as an `isError: true` MCP response from the dispatcher.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import {
	type ClassDeclaration,
	type Decorator,
	Node,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";

import {
	evaluateLiteral,
	extractEnvRef,
	findCallExpressions,
	findClassesByDecorator,
	isLoadError,
	isPlainRecord,
	isUnevaluated,
	type JsonLikeValue,
	type LoadedProject,
	loadProject,
} from "../util/ts-static-parser.js";

export {
	INTROSPECT_TOOLS,
	isIntrospectTool,
} from "./introspect.descriptors.js";

/**
 * Standalone dispatcher used both by the server (via
 * `setRequestHandler`) and by `docs.explain` for symbol fallback.
 * Returns a plain JS value (handler shaped) — caller wraps it as
 * MCP content if needed.
 */
export function dispatchIntrospect(
	root: string,
	name: string,
	args: Record<string, unknown> = {},
): unknown {
	const loaded = loadProject(root);
	if (isLoadError(loaded)) return shapeError(loaded.error, loaded.hint);

	switch (name) {
		case "list.routes":
			return wrap(loaded, listRoutes(loaded));
		case "list.entities":
			return wrap(loaded, listEntities(loaded));
		case "list.events":
			return wrap(loaded, listEvents(loaded));
		case "list.providers":
			return wrap(loaded, listProviders(loaded));
		case "list.middleware":
			return wrap(loaded, listMiddleware(loaded, root));
		case "get.config":
			return wrap(loaded, getConfig(loaded, root, args));
		default:
			return shapeError(`Unknown introspect tool: ${name}`, "");
	}
}

type Confidence = "high" | "medium" | "low";

function wrap<T extends Record<string, unknown>>(
	loaded: LoadedProject,
	body: T,
	extraGaps: string[] = [],
): T & { confidence: Confidence; knownGaps: string[] } {
	const parseGaps =
		loaded.parseErrors.length > 0
			? loaded.parseErrors.map((p) => `parse error in ${p}`)
			: [];
	const knownGaps = [...parseGaps, ...extraGaps];
	return {
		...body,
		confidence: knownGaps.length === 0 ? "high" : "medium",
		knownGaps,
	};
}

/**
 * Shape every error response identically. The spec contract says
 * `{ error, hint, knownGaps? }` — the `knownGaps` field is included
 * (empty array) so the LLM can always read it without checking
 * presence.
 */
function shapeError(
	error: string,
	hint: string,
): {
	error: string;
	hint: string;
	knownGaps: string[];
} {
	return { error, hint, knownGaps: [] };
}

// ---------------------------------------------------------------- routes

interface RouteRow {
	method: string;
	path: string;
	controller: string | null;
	action: string;
	middleware: string[];
	guards: string[];
	file: string;
	line: number;
}

const HTTP_VERBS = new Set([
	"get",
	"post",
	"put",
	"patch",
	"delete",
	"any",
	"head",
	"options",
]);

function listRoutes(loaded: LoadedProject): { routes: RouteRow[] } {
	const direct = findCallExpressions(loaded.project, (leaf, _full) =>
		HTTP_VERBS.has(leaf),
	);
	const routes: RouteRow[] = [];
	for (const site of direct) {
		// We only want calls whose callee is `<something>.<verb>` where
		// `<something>` ends in `router` (case-insensitive). Also accept
		// the bare `router.get(...)`. This is intentionally lax — any
		// false positives are rare and easy to spot.
		const expr = site.expr.getExpression();
		if (!Node.isPropertyAccessExpression(expr)) continue;
		const calleeRoot = expr.getExpression().getText();
		if (!isRouterCallee(calleeRoot, site.expr)) continue;

		const verb = expr.getName();
		const args = site.expr.getArguments();
		const pathArg = args[0];
		const handlerArg = args[1];
		if (!pathArg) continue;
		const pathLit = evaluateLiteral(pathArg);
		const path =
			typeof pathLit === "string" ? pathLit : `<${pathArg.getText()}>`;

		const { controller, action } = describeHandler(handlerArg);
		const enclosing = findEnclosingGroupContext(site.expr);

		routes.push({
			method: verb.toUpperCase(),
			path: enclosing.prefix + path,
			controller,
			action,
			middleware: [...enclosing.middleware],
			guards: [...enclosing.guards],
			file: site.file,
			line: site.line,
		});
	}
	routes.sort((a, b) =>
		a.method === b.method
			? a.path.localeCompare(b.path)
			: a.method.localeCompare(b.method),
	);
	return { routes };
}

function isRouterCallee(calleeRootText: string, _expr: Node): boolean {
	const lc = calleeRootText.toLowerCase();
	return lc === "router" || lc.endsWith(".router") || lc.endsWith("router");
}

function describeHandler(arg: Node | undefined): {
	controller: string | null;
	action: string;
} {
	if (!arg) return { controller: null, action: "<missing>" };
	if (Node.isArrayLiteralExpression(arg)) {
		const els = arg.getElements();
		const ctrl = els[0]?.getText() ?? null;
		const act = els[1] ? evaluateLiteral(els[1]) : null;
		return {
			controller: ctrl,
			action: typeof act === "string" ? act : "<inline>",
		};
	}
	return { controller: null, action: "<inline>" };
}

interface GroupContext {
	prefix: string;
	middleware: string[];
	guards: string[];
}

function emptyCtx(): GroupContext {
	// Fresh object per call so callers can't accidentally share or
	// mutate a shared singleton.
	return { prefix: "", middleware: [], guards: [] };
}

/**
 * Walk up the AST collecting EVERY enclosing
 * `router.group(() => { ... })` along the way and merge their
 * chained `.prefix`/`.middleware`/`.guard` config in OUTER → INNER
 * order. Nested groups compose: outer prefix prepends to inner.
 *
 * Ream's `Router.ts:475-476` prepends group-level middleware/guards
 * to each child, matching the shape we emit here.
 */
function findEnclosingGroupContext(node: Node): GroupContext {
	const chain: Node[] = [];
	let cur: Node | undefined = node.getParent();
	while (cur) {
		if (Node.isCallExpression(cur)) {
			const expr = cur.getExpression();
			if (Node.isPropertyAccessExpression(expr) && expr.getName() === "group") {
				chain.push(cur);
			}
		}
		cur = cur.getParent();
	}
	if (chain.length === 0) return emptyCtx();
	// Merge from OUTERMOST to INNERMOST: the last entry in `chain`
	// is the outermost group (deepest parent in the walk). Outer
	// prefix prepends to inner, outer middleware prepends to inner.
	let merged = emptyCtx();
	for (let i = chain.length - 1; i >= 0; i--) {
		const groupCtx = readGroupChain(chain[i] as Node);
		merged = {
			prefix: merged.prefix + groupCtx.prefix,
			middleware: [...merged.middleware, ...groupCtx.middleware],
			guards: [...merged.guards, ...groupCtx.guards],
		};
	}
	return merged;
}

function readGroupChain(groupCall: Node): GroupContext {
	let ctx: GroupContext = { prefix: "", middleware: [], guards: [] };
	// Walk the property-access chain on the group call's parent
	// expressions: `router.group(...).prefix(...).middleware(...)`.
	let chain: Node | undefined = groupCall.getParent();
	while (chain && Node.isPropertyAccessExpression(chain)) {
		const callParent = chain.getParent();
		if (!callParent || !Node.isCallExpression(callParent)) break;
		const method = chain.getName();
		const args = callParent.getArguments();
		if (method === "prefix" && args[0]) {
			const v = evaluateLiteral(args[0]);
			if (typeof v === "string") ctx = { ...ctx, prefix: v + ctx.prefix };
		} else if (method === "middleware") {
			const names = args
				.map((a) => evaluateLiteral(a))
				.filter((v): v is string => typeof v === "string");
			ctx = { ...ctx, middleware: [...names, ...ctx.middleware] };
		} else if (method === "guard" || method === "guards") {
			const names = args
				.map((a) => evaluateLiteral(a))
				.filter((v): v is string => typeof v === "string");
			ctx = { ...ctx, guards: [...names, ...ctx.guards] };
		}
		chain = callParent.getParent();
	}
	return ctx;
}

// ---------------------------------------------------------------- entities

interface EntityRow {
	name: string;
	table: string | null;
	columns: { name: string; type: string | null }[];
	relations: { name: string; kind: string; target: string }[];
	hooks: { name: string; method: string }[];
	file: string;
	line: number;
}

const RELATION_DECORATORS = new Set([
	"HasMany",
	"HasOne",
	"BelongsTo",
	"ManyToMany",
]);

const HOOK_DECORATORS = new Set([
	"BeforeSave",
	"AfterSave",
	"BeforeCreate",
	"AfterCreate",
	"BeforeUpdate",
	"AfterUpdate",
	"BeforeDelete",
	"AfterDelete",
	"BeforeFind",
	"AfterFind",
]);

function listEntities(loaded: LoadedProject): { entities: EntityRow[] } {
	const decorated = findClassesByDecorator(loaded.project, "Entity");
	const out: EntityRow[] = [];
	for (const e of decorated) {
		out.push(buildEntityRow(e.decl, e.decorator, e.file, e.line));
	}
	return { entities: out };
}

function buildEntityRow(
	decl: ClassDeclaration,
	dec: Decorator,
	file: string,
	line: number,
): EntityRow {
	const tableArg = dec.getArguments()[0];
	const tableLit = tableArg ? evaluateLiteral(tableArg) : null;
	let table: string | null = null;
	if (typeof tableLit === "string") {
		// `@Entity('users')` — bare string literal arg.
		table = tableLit;
	} else if (
		isPlainRecord(tableLit as JsonLikeValue) &&
		typeof (tableLit as { table?: unknown }).table === "string"
	) {
		// `@Entity({ table: 'users' })` — common config-object shape.
		table = (tableLit as { table: string }).table;
	}

	const columns: EntityRow["columns"] = [];
	const relations: EntityRow["relations"] = [];
	for (const prop of decl.getInstanceProperties()) {
		if (!Node.isPropertyDeclaration(prop)) continue;
		for (const d of prop.getDecorators()) {
			const name = d.getName();
			if (name === "Column") {
				const typeNode = prop.getTypeNode();
				columns.push({
					name: prop.getName(),
					type: typeNode ? typeNode.getText() : null,
				});
				break;
			}
			if (RELATION_DECORATORS.has(name)) {
				const args = d.getArguments();
				const targetArg = args[args.length - 1];
				const target = targetArg ? targetArg.getText() : "<unknown>";
				relations.push({
					name: prop.getName(),
					kind: name,
					target,
				});
				break;
			}
		}
	}

	const hooks: EntityRow["hooks"] = [];
	for (const m of decl.getMethods()) {
		for (const d of m.getDecorators()) {
			if (HOOK_DECORATORS.has(d.getName())) {
				hooks.push({ name: d.getName(), method: m.getName() });
				break;
			}
		}
	}

	return {
		name: decl.getName() ?? "<anonymous>",
		table,
		columns,
		relations,
		hooks,
		file,
		line,
	};
}

// ---------------------------------------------------------------- events

interface EventRow {
	event: string | null;
	expression?: string;
	subscribers: { file: string; line: number; target: string | null }[];
	emitters: { file: string; line: number; expression?: string }[];
}

function listEvents(loaded: LoadedProject): { events: EventRow[] } {
	const subscribers = collectSubscribers(loaded);
	const emitters = collectEmitters(loaded);

	const byEvent = new Map<string, EventRow>();
	const dynamic: EventRow[] = [];

	for (const s of subscribers) {
		if (s.event === null) {
			dynamic.push({
				event: null,
				expression: s.expression,
				subscribers: [{ file: s.file, line: s.line, target: s.target }],
				emitters: [],
			});
			continue;
		}
		const row = byEvent.get(s.event) ?? {
			event: s.event,
			subscribers: [],
			emitters: [],
		};
		row.subscribers.push({ file: s.file, line: s.line, target: s.target });
		byEvent.set(s.event, row);
	}
	for (const e of emitters) {
		if (e.event === null) {
			dynamic.push({
				event: null,
				expression: e.expression,
				subscribers: [],
				emitters: [{ file: e.file, line: e.line, expression: e.expression }],
			});
			continue;
		}
		const row = byEvent.get(e.event) ?? {
			event: e.event,
			subscribers: [],
			emitters: [],
		};
		row.emitters.push({ file: e.file, line: e.line });
		byEvent.set(e.event, row);
	}

	const events = [...byEvent.values()].sort((a, b) =>
		(a.event ?? "").localeCompare(b.event ?? ""),
	);
	return { events: [...events, ...dynamic] };
}

interface CollectedSubscriber {
	event: string | null;
	expression?: string;
	target: string | null;
	file: string;
	line: number;
}

function collectSubscribers(loaded: LoadedProject): CollectedSubscriber[] {
	const out: CollectedSubscriber[] = [];

	// `bus.subscribe('event', listener)` — leaf-name match on `subscribe`.
	const calls = findCallExpressions(
		loaded.project,
		(leaf) => leaf === "subscribe",
	);
	for (const c of calls) {
		const expr = c.expr.getExpression();
		if (!Node.isPropertyAccessExpression(expr)) continue;
		const root = expr.getExpression().getText().toLowerCase();
		if (!root.endsWith("bus") && root !== "bus") continue;
		const args = c.expr.getArguments();
		const first = args[0];
		if (!first) continue;
		const lit = evaluateLiteral(first);
		out.push({
			event: typeof lit === "string" ? lit : null,
			expression: typeof lit === "string" ? undefined : first.getText(),
			target: null,
			file: c.file,
			line: c.line,
		});
	}

	// `@EventListener('event')` decorated classes.
	const listeners = findClassesByDecorator(loaded.project, "EventListener");
	for (const l of listeners) {
		const arg = l.decorator.getArguments()[0];
		const lit = arg ? evaluateLiteral(arg) : null;
		out.push({
			event: typeof lit === "string" ? lit : null,
			expression:
				typeof lit === "string" ? undefined : (arg?.getText() ?? "<no-arg>"),
			target: l.decl.getName() ?? null,
			file: l.file,
			line: l.line,
		});
	}

	return out;
}

interface CollectedEmitter {
	event: string | null;
	expression?: string;
	file: string;
	line: number;
}

function collectEmitters(loaded: LoadedProject): CollectedEmitter[] {
	const out: CollectedEmitter[] = [];
	const calls = findCallExpressions(
		loaded.project,
		(leaf) => leaf === "emit" || leaf === "dispatch",
	);
	for (const c of calls) {
		const expr = c.expr.getExpression();
		if (!Node.isPropertyAccessExpression(expr)) continue;
		const root = expr.getExpression().getText().toLowerCase();
		if (!root.endsWith("bus") && root !== "bus" && !root.endsWith("emitter"))
			continue;
		const args = c.expr.getArguments();
		const first = args[0];
		if (!first) continue;
		const lit = evaluateLiteral(first);
		if (typeof lit === "string") {
			out.push({ event: lit, file: c.file, line: c.line });
			continue;
		}
		// `bus.emit(new SomeEvent(...))` OR `bus.emit(SomeEvent)` —
		// read the class's static EVENT_NAME if available. Returns
		// `{ name, ambiguous }` so we can downgrade confidence when
		// two classes share a name across files.
		const resolved = readEventNameFromExpr(loaded, first);
		out.push({
			event: resolved.name,
			expression: resolved.name === null ? first.getText() : undefined,
			file: c.file,
			line: c.line,
		});
	}
	return out;
}

interface ResolvedEventName {
	name: string | null;
	/** True when more than one class with the same name exists in the
	 *  project. Caller surfaces this in `knownGaps`. */
	ambiguous: boolean;
}

function readEventNameFromExpr(
	loaded: LoadedProject,
	arg: Node,
): ResolvedEventName {
	let ctorName: string | null = null;
	if (Node.isNewExpression(arg)) {
		ctorName = arg.getExpression().getText();
	} else if (Node.isIdentifier(arg)) {
		// `bus.emit(SomeEvent)` — class identifier passed directly.
		ctorName = arg.getText();
	}
	if (!ctorName) return { name: null, ambiguous: false };

	const matches: string[] = [];
	for (const sf of loaded.project.getSourceFiles()) {
		if (sf.getFilePath().includes("/node_modules/")) continue;
		for (const cls of sf.getClasses()) {
			if (cls.getName() !== ctorName) continue;
			const lit = readStaticEventName(cls);
			if (lit !== null) matches.push(lit);
		}
	}
	if (matches.length === 0) return { name: null, ambiguous: false };
	const allSame = matches.every((m) => m === matches[0]);
	return {
		name: matches[0] ?? null,
		ambiguous: !allSame,
	};
}

/**
 * Read a class's static `EVENT_NAME` literal — supports both
 * `static EVENT_NAME = 'foo'` (PropertyDeclaration) AND
 * `static get EVENT_NAME() { return 'foo' }` (GetAccessor with
 * a string-literal return).
 */
function readStaticEventName(cls: ClassDeclaration): string | null {
	const prop = cls.getStaticProperty("EVENT_NAME");
	if (!prop) return null;
	if (Node.isPropertyDeclaration(prop)) {
		const init = prop.getInitializer();
		if (!init) return null;
		const lit = evaluateLiteral(init);
		return typeof lit === "string" ? lit : null;
	}
	if (Node.isGetAccessorDeclaration(prop)) {
		// Walk the body for a `return '<literal>'` statement.
		const body = prop.getBody();
		if (!body || !Node.isBlock(body)) return null;
		for (const stmt of body.getStatements()) {
			if (!Node.isReturnStatement(stmt)) continue;
			const expr = stmt.getExpression();
			if (!expr) continue;
			const lit = evaluateLiteral(expr);
			if (typeof lit === "string") return lit;
		}
	}
	return null;
}

// ---------------------------------------------------------------- providers

interface ProviderRow {
	name: string;
	file: string;
	line: number;
	lifecycle: {
		register: number | null;
		boot: number | null;
		shutdown: number | null;
	};
	bindings: {
		kind: "bind" | "singleton";
		token: string | { unevaluated: true; expression: string };
		file: string;
		line: number;
	}[];
}

function listProviders(loaded: LoadedProject): { providers: ProviderRow[] } {
	const out: ProviderRow[] = [];
	for (const sf of loaded.project.getSourceFiles()) {
		if (sf.getFilePath().includes("/node_modules/")) continue;
		if (sf.getFilePath().endsWith(".d.ts")) continue;
		for (const cls of sf.getClasses()) {
			const name = cls.getName();
			if (!name?.endsWith("Provider")) continue;
			out.push(buildProviderRow(cls, sf));
		}
	}
	return { providers: out };
}

function buildProviderRow(cls: ClassDeclaration, sf: SourceFile): ProviderRow {
	const lifecycle: ProviderRow["lifecycle"] = {
		register: null,
		boot: null,
		shutdown: null,
	};
	for (const m of cls.getMethods()) {
		const n = m.getName();
		if (n === "register") lifecycle.register = m.getStartLineNumber();
		else if (n === "boot") lifecycle.boot = m.getStartLineNumber();
		else if (n === "shutdown") lifecycle.shutdown = m.getStartLineNumber();
	}

	const bindings: ProviderRow["bindings"] = [];
	cls.forEachDescendant((node) => {
		if (!Node.isCallExpression(node)) return;
		const expr = node.getExpression();
		if (!Node.isPropertyAccessExpression(expr)) return;
		const method = expr.getName();
		if (method !== "bind" && method !== "singleton") return;
		const args = node.getArguments();
		const first = args[0];
		if (!first) return;
		const lit = evaluateLiteral(first);
		const token =
			typeof lit === "string"
				? lit
				: {
						unevaluated: true as const,
						expression: first.getText(),
					};
		bindings.push({
			kind: method === "bind" ? "bind" : "singleton",
			token,
			file: sf.getFilePath(),
			line: node.getStartLineNumber(),
		});
	});

	return {
		name: cls.getName() ?? "<anonymous>",
		file: sf.getFilePath(),
		line: cls.getStartLineNumber(),
		lifecycle,
		bindings,
	};
}

// ---------------------------------------------------------------- middleware

interface MiddlewareRow {
	name: string;
	kind: "global" | "named";
	ref: string;
	file: string;
	line: number;
}

function listMiddleware(
	loaded: LoadedProject,
	root: string,
):
	| { middleware: MiddlewareRow[] }
	| { error: string; hint: string; knownGaps: string[] } {
	const candidates = [
		join(root, "app", "HttpKernel.ts"),
		join(root, "src", "HttpKernel.ts"),
	];
	let kernelFile: SourceFile | null = null;
	for (const path of candidates) {
		if (existsSync(path)) {
			kernelFile = loaded.project.addSourceFileAtPathIfExists(path) ?? null;
			if (kernelFile) break;
		}
	}
	if (!kernelFile) {
		return shapeError(
			"no middleware kernel found",
			"expected app/HttpKernel.ts or src/HttpKernel.ts with a globalMiddleware array",
		);
	}

	const out: MiddlewareRow[] = [];
	for (const cls of kernelFile.getClasses()) {
		extractKernelArrays(cls, kernelFile, out);
	}
	// Some kernels declare arrays at module scope rather than in a
	// class — accept that shape too.
	for (const v of kernelFile.getVariableDeclarations()) {
		const name = v.getName();
		if (name !== "globalMiddleware" && name !== "namedMiddleware") continue;
		const init = v.getInitializer();
		if (!init) continue;
		appendKernelEntries(name, init, kernelFile, out);
	}

	return { middleware: out };
}

function extractKernelArrays(
	cls: ClassDeclaration,
	sf: SourceFile,
	out: MiddlewareRow[],
): void {
	const handle = (name: string, init: Node | undefined) => {
		if (!init) return;
		if (name !== "globalMiddleware" && name !== "namedMiddleware") return;
		appendKernelEntries(name, init, sf, out);
	};
	for (const prop of cls.getInstanceProperties()) {
		const name = prop.getName();
		if (Node.isPropertyDeclaration(prop)) {
			handle(name, prop.getInitializer());
		} else if (Node.isGetAccessorDeclaration(prop)) {
			// `get globalMiddleware() { return [Auth, Cors] }` — pick
			// the array literal off the first return statement.
			const body = prop.getBody();
			if (body && Node.isBlock(body)) {
				for (const stmt of body.getStatements()) {
					if (!Node.isReturnStatement(stmt)) continue;
					const expr = stmt.getExpression();
					if (expr) handle(name, expr);
				}
			}
		}
	}
	for (const prop of cls.getStaticProperties()) {
		if (!Node.isPropertyDeclaration(prop)) continue;
		const name = prop.getName();
		handle(name, prop.getInitializer());
	}
}

function appendKernelEntries(
	source: "globalMiddleware" | "namedMiddleware",
	init: Node,
	sf: SourceFile,
	out: MiddlewareRow[],
): void {
	const kind: "global" | "named" =
		source === "globalMiddleware" ? "global" : "named";

	if (Node.isArrayLiteralExpression(init)) {
		for (const el of init.getElements()) {
			out.push({
				name: el.getText(),
				kind,
				ref: el.getText(),
				file: sf.getFilePath(),
				line: el.getStartLineNumber(),
			});
		}
		return;
	}
	if (Node.isObjectLiteralExpression(init)) {
		for (const prop of init.getProperties()) {
			if (!Node.isPropertyAssignment(prop)) continue;
			const valueNode = prop.getInitializer();
			out.push({
				name: prop.getName(),
				kind,
				ref: valueNode?.getText() ?? "<unknown>",
				file: sf.getFilePath(),
				line: prop.getStartLineNumber(),
			});
		}
	}
}

// ---------------------------------------------------------------- config

function getConfig(
	loaded: LoadedProject,
	root: string,
	args: Record<string, unknown>,
):
	| {
			config: Record<string, JsonLikeValue>;
			knownGaps?: string[];
			file?: string;
	  }
	| { error: string; hint: string; knownGaps: string[] } {
	const configDir = join(root, "config");
	if (!existsSync(configDir)) {
		return shapeError(
			"config directory not found",
			`expected ${relative(root, configDir) || "config"}/ at project root`,
		);
	}
	const files = readdirSync(configDir).filter((f) => f.endsWith(".ts"));
	const tree: Record<string, JsonLikeValue> = {};
	const gaps: string[] = [];
	for (const f of files) {
		const path = join(configDir, f);
		const sf =
			loaded.project.getSourceFile(path) ??
			loaded.project.addSourceFileAtPathIfExists(path);
		if (!sf) continue;
		const value = readConfigFile(sf);
		const key = f.replace(/\.ts$/, "");
		tree[key] = value;
		// Walk the parsed tree once to find unevaluated leaves and
		// spread/ternary markers — surface them so the agent knows
		// the config view is partial.
		collectGaps(value, [key], gaps);
	}

	const key = typeof args.key === "string" ? args.key : null;
	if (!key)
		return gaps.length > 0
			? { config: tree, knownGaps: gaps }
			: { config: tree };

	const segments = key.split(".");
	let cur: JsonLikeValue = tree;
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i] as string;
		if (isUnevaluated(cur)) {
			return shapeError("cannot descend into unevaluated node", cur.expression);
		}
		if (!isPlainRecord(cur)) {
			return shapeError(
				`cannot descend into non-object at '${segments.slice(0, i).join(".")}'`,
				`value is ${Array.isArray(cur) ? "array" : typeof cur}`,
			);
		}
		if (seg in cur) {
			cur = cur[seg] as JsonLikeValue;
			continue;
		}
		const available = Object.keys(cur).sort().join(", ");
		return shapeError(
			`key '${segments.slice(0, i + 1).join(".")}' not found`,
			`available keys at this level: [${available}]`,
		);
	}
	return { config: { [key]: cur } };
}

/**
 * Walk a parsed config subtree, push a human-readable gap line for
 * every unevaluated node and every spread placeholder. Used to fill
 * `knownGaps` on `get.config` so the agent knows the tree isn't a
 * complete picture of runtime config.
 */
function collectGaps(
	value: JsonLikeValue,
	path: string[],
	gaps: string[],
): void {
	if (isUnevaluated(value)) {
		gaps.push(`unevaluated at ${path.join(".")}: ${value.expression}`);
		return;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			collectGaps(value[i] as JsonLikeValue, [...path, String(i)], gaps);
		}
		return;
	}
	if (isPlainRecord(value)) {
		for (const [k, v] of Object.entries(value)) {
			if (k.startsWith("...")) {
				gaps.push(`spread at ${[...path, k].join(".")}`);
				continue;
			}
			collectGaps(v, [...path, k], gaps);
		}
	}
}

function readConfigFile(sf: SourceFile): JsonLikeValue {
	// Look for `defineConfig({ ... })` first (canonical Ream pattern),
	// then a default export object literal.
	const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
	for (const call of calls) {
		const expr = call.getExpression();
		if (expr.getText() === "defineConfig") {
			const arg = call.getArguments()[0];
			if (arg) return substituteEnvRefs(evaluateLiteral(arg));
		}
	}
	for (const dx of sf.getExportAssignments()) {
		const inner = dx.getExpression();
		return substituteEnvRefs(evaluateLiteral(inner));
	}
	return {
		unevaluated: true,
		expression: `<no defineConfig() or default export found in ${sf.getBaseName()}>`,
	};
}

function substituteEnvRefs(value: JsonLikeValue): JsonLikeValue {
	if (Array.isArray(value)) return value.map((v) => substituteEnvRefs(v));
	if (isPlainRecord(value)) {
		const out: { [k: string]: JsonLikeValue } = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = substituteEnvRefs(v);
		}
		return out;
	}
	// Primitives (string/number/boolean/null), env refs, and
	// unevaluated nodes are already in their final shape.
	return value;
}

// `extractEnvRef` is consumed by `evaluateLiteral`; re-export to make
// the unit-test surface explicit.
export { extractEnvRef };
