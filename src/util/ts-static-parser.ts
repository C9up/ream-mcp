/**
 * Shared ts-morph infrastructure for `introspect.*` tools.
 *
 * Loads a `Project` against the user's `tsconfig.json` WITHOUT
 * triggering the type checker (`skipFileDependencyResolution: true`)
 * so file walks stay ~200ms on a 500-file repo. Decorator and call
 * matching is by leaf identifier name only — no semantic resolution.
 *
 * The loaded project is cached per project-root keyed on the
 * tsconfig's mtime, so back-to-back tool calls reuse one in-memory
 * AST. Cache invalidates when tsconfig changes.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import {
	type CallExpression,
	type ClassDeclaration,
	type Decorator,
	type Identifier,
	Node,
	type ObjectLiteralExpression,
	type PrefixUnaryExpression,
	Project,
	type PropertyAccessExpression,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";

export interface LoadedProject {
	project: Project;
	tsConfigPath: string;
	parseErrors: string[];
}

export interface LoadError {
	error: string;
	hint: string;
}

interface CacheEntry {
	project: Project;
	tsConfigPath: string;
	parseErrors: string[];
	tsConfigMtimeMs: number;
}

const CACHE = new Map<string, CacheEntry>();

export function loadProject(root: string): LoadedProject | LoadError {
	// Source-folder check up-front — spec contract: missing app/ AND
	// src/ surfaces a structured error rather than an empty project.
	const hasApp = existsSync(join(root, "app"));
	const hasSrc = existsSync(join(root, "src"));
	if (!hasApp && !hasSrc) {
		return {
			error: "expected app/ or src/ directory",
			hint: `looked under ${root}; neither app/ nor src/ exists`,
		};
	}

	const tsConfigPath = pickTsConfig(root);
	if (!tsConfigPath) {
		return {
			error: "tsconfig.json not found",
			hint: `expected ${root}/tsconfig.json (or ./app/tsconfig.json or ./src/tsconfig.json)`,
		};
	}

	let mtime: number;
	try {
		mtime = statSync(tsConfigPath).mtimeMs;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			error: "tsconfig.json stat failed",
			hint: detail,
		};
	}

	const cached = CACHE.get(root);
	if (
		cached &&
		cached.tsConfigPath === tsConfigPath &&
		cached.tsConfigMtimeMs === mtime
	) {
		// Cache hit on tsconfig — but the source files inside the
		// project may have changed. ts-morph's `refreshFromFileSystem`
		// reloads any file whose disk mtime differs from the in-memory
		// AST. Cheap when nothing changed (~few ms on a 500-file repo);
		// O(changed-files * parse-cost) when something did.
		try {
			cached.project.getSourceFiles().forEach((sf) => {
				try {
					sf.refreshFromFileSystemSync();
				} catch {
					// File deleted between calls — ts-morph throws on
					// missing files. Drop it from the project so it
					// doesn't surface in future walks.
					cached.project.removeSourceFile(sf);
				}
			});
		} catch {
			// Whole-project refresh failure: fall through to re-init
			// rather than returning a partially-broken cache.
			CACHE.delete(root);
		}
		const stillValid = CACHE.get(root) === cached;
		if (stillValid) {
			// A newly-created .ts file doesn't bump the tsconfig mtime, so the
			// refresh loop above (which only reloads/removes already-known files)
			// never surfaces it — the persistent server would omit it from every
			// walk until restart. Re-read the tsconfig globs; ts-morph skips files
			// already in the project, so this only picks up the new ones.
			try {
				const added = cached.project.addSourceFilesFromTsConfig(tsConfigPath);
				if (added.length > 0) {
					const newErrors = collectParseErrors(added);
					if (newErrors.length > 0) {
						cached.parseErrors = [
							...new Set([...cached.parseErrors, ...newErrors]),
						];
					}
				}
			} catch {
				// Malformed tsconfig between calls — keep serving the cached
				// project rather than failing the whole call.
			}
			return {
				project: cached.project,
				tsConfigPath: cached.tsConfigPath,
				parseErrors: cached.parseErrors,
			};
		}
	}

	let project: Project;
	try {
		project = new Project({
			tsConfigFilePath: tsConfigPath,
			skipFileDependencyResolution: true,
			skipAddingFilesFromTsConfig: false,
			compilerOptions: {
				// Keep the loader off the network/type-graph; we only
				// need syntactic walks.
				noResolve: true,
				noLib: true,
			},
		});
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			error: "ts-morph failed to load project",
			hint: detail,
		};
	}

	const parseErrors = collectParseErrors(project.getSourceFiles());

	const entry: CacheEntry = {
		project,
		tsConfigPath,
		parseErrors,
		tsConfigMtimeMs: mtime,
	};
	CACHE.set(root, entry);
	return {
		project,
		tsConfigPath,
		parseErrors,
	};
}

/** Files with parser-shape errors (TS1xxx). Semantic errors (TS2xxx) are noise without the type checker. */
function collectParseErrors(sourceFiles: SourceFile[]): string[] {
	const out: string[] = [];
	for (const sf of sourceFiles) {
		const syntactic = sf.getPreEmitDiagnostics().filter((d) => {
			const code = d.getCode();
			return code >= 1000 && code < 2000;
		});
		if (syntactic.length > 0) out.push(sf.getFilePath());
	}
	return out;
}

export function isLoadError(v: LoadedProject | LoadError): v is LoadError {
	return (
		typeof v === "object" &&
		v !== null &&
		"error" in v &&
		typeof (v as LoadError).error === "string"
	);
}

function pickTsConfig(root: string): string | null {
	const candidates = [
		join(root, "tsconfig.json"),
		join(root, "app", "tsconfig.json"),
		join(root, "src", "tsconfig.json"),
	];
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return null;
}

/**
 * Iterate over every project source file, skipping `*.d.ts` and
 * anything under `node_modules`. Most tool walks start here.
 */
export function eachSourceFile(
	project: Project,
	visit: (sf: SourceFile) => void,
): void {
	for (const sf of project.getSourceFiles()) {
		const path = sf.getFilePath();
		if (path.endsWith(".d.ts")) continue;
		if (path.includes("/node_modules/")) continue;
		visit(sf);
	}
}

export interface CallSite {
	expr: CallExpression;
	file: string;
	line: number;
}

/**
 * Find every call expression in the project where `predicate(text)`
 * returns true on the call's leading-name text. Cheap leaf-name
 * matching: catches `bus.subscribe(...)` AND `this.bus.subscribe(...)`
 * because both end with `.subscribe`.
 */
export function findCallExpressions(
	project: Project,
	predicate: (leafName: string, fullText: string) => boolean,
): CallSite[] {
	const out: CallSite[] = [];
	eachSourceFile(project, (sf) => {
		sf.forEachDescendant((node) => {
			if (!Node.isCallExpression(node)) return;
			const expr = node.getExpression();
			const fullText = expr.getText();
			const leaf = leafName(expr);
			if (!predicate(leaf, fullText)) return;
			const start = node.getStartLineNumber();
			out.push({
				expr: node,
				file: sf.getFilePath(),
				line: start,
			});
		});
	});
	return out;
}

function leafName(expr: Node): string {
	if (Node.isPropertyAccessExpression(expr)) {
		return expr.getName();
	}
	if (Node.isIdentifier(expr)) {
		return expr.getText();
	}
	return expr.getText().split(".").pop() ?? "";
}

export interface DecoratedClass {
	decl: ClassDeclaration;
	decorator: Decorator;
	file: string;
	line: number;
}

/**
 * Find every class with a decorator whose leaf name equals
 * `decoratorName`. Returns the first matching decorator per class
 * (multi-decorator classes still appear once; caller picks).
 */
export function findClassesByDecorator(
	project: Project,
	decoratorName: string,
): DecoratedClass[] {
	const out: DecoratedClass[] = [];
	eachSourceFile(project, (sf) => {
		for (const cls of sf.getClasses()) {
			for (const dec of cls.getDecorators()) {
				if (dec.getName() === decoratorName) {
					out.push({
						decl: cls,
						decorator: dec,
						file: sf.getFilePath(),
						line: cls.getStartLineNumber(),
					});
					break;
				}
			}
		}
	});
	return out;
}

/**
 * Recursive literal evaluator. Walks object/array/primitive literals;
 * any node it can't reduce to a JSON value comes back as
 * `{ unevaluated: true, expression: "<source text>" }` so the LLM
 * sees the gap rather than a silent `null`.
 *
 * Recognizes `process.env.X` and `env('X', d)` as env refs and
 * surfaces them as `{ env, default }`.
 */
export interface UnevaluatedExpression {
	unevaluated: true;
	expression: string;
}

export interface EnvRef {
	env: string;
	default: JsonLikeValue | null;
}

export type JsonLikeValue =
	| string
	| number
	| boolean
	| null
	| JsonLikeValue[]
	| { [k: string]: JsonLikeValue }
	| UnevaluatedExpression
	| EnvRef;

export function evaluateLiteral(node: Node): JsonLikeValue {
	return evalWithVisited(node, new Set());
}

/**
 * Internal recursive form. The `visited` set guards against cycles
 * like `const x = x` or mutually-recursive declarations across
 * files — without it, ts-morph's `getDefinitionNodes()` can resolve
 * an identifier to itself and blow the stack.
 */
function evalWithVisited(node: Node, visited: Set<Node>): JsonLikeValue {
	if (visited.has(node)) return unevaluated(node);
	visited.add(node);

	if (
		Node.isStringLiteral(node) ||
		Node.isNoSubstitutionTemplateLiteral(node)
	) {
		return node.getLiteralValue();
	}
	if (Node.isNumericLiteral(node)) return Number(node.getLiteralText());
	if (Node.isTrueLiteral(node)) return true;
	if (Node.isFalseLiteral(node)) return false;
	if (node.getKind() === SyntaxKind.NullKeyword) return null;
	if (Node.isPrefixUnaryExpression(node)) return evalPrefixUnary(node, visited);
	if (Node.isArrayLiteralExpression(node)) {
		return node.getElements().map((el) => evalWithVisited(el, visited));
	}
	if (Node.isObjectLiteralExpression(node)) {
		return evalObjectLiteral(node, visited);
	}
	if (Node.isAsExpression(node) || Node.isParenthesizedExpression(node)) {
		return evalWithVisited(node.getExpression(), visited);
	}
	if (Node.isCallExpression(node)) {
		return extractEnvRef(node) ?? unevaluated(node);
	}
	if (Node.isPropertyAccessExpression(node)) {
		return evalPropertyAccess(node, visited);
	}
	if (Node.isIdentifier(node)) return evalIdentifier(node, visited);
	return unevaluated(node);
}

/** `-1` / `+1` on an already-evaluated numeric operand; else unevaluated. */
function evalPrefixUnary(
	node: PrefixUnaryExpression,
	visited: Set<Node>,
): JsonLikeValue {
	const operator = node.getOperatorToken();
	const operand = evalWithVisited(node.getOperand(), visited);
	if (typeof operand === "number") {
		if (operator === SyntaxKind.MinusToken) return -operand;
		if (operator === SyntaxKind.PlusToken) return operand;
	}
	return unevaluated(node);
}

/** Evaluate an object literal, recursing into each property initializer. */
function evalObjectLiteral(
	node: ObjectLiteralExpression,
	visited: Set<Node>,
): JsonLikeValue {
	const out: { [k: string]: JsonLikeValue } = {};
	for (const prop of node.getProperties()) {
		if (Node.isPropertyAssignment(prop)) {
			const nameNode = prop.getNameNode();
			const key = Node.isComputedPropertyName(nameNode)
				? nameNode.getText()
				: nameNode.getText().replace(/^['"]|['"]$/g, "");
			const init = prop.getInitializer();
			out[key] = init ? evalWithVisited(init, visited) : null;
		} else if (Node.isShorthandPropertyAssignment(prop)) {
			out[prop.getName()] = unevaluated(prop);
		} else if (Node.isSpreadAssignment(prop)) {
			out[`...${prop.getExpression().getText()}`] = unevaluated(
				prop.getExpression(),
			);
		}
	}
	return out;
}

/**
 * `obj.prop` — env-ref takes precedence; otherwise resolve against an
 * `as const` object literal in scope (same-file only, inherited from
 * `getDefinitionNodes()` + the `noResolve` compiler option). `isPlainRecord`
 * keeps sentinel (env-ref / unevaluated) values from being indexed as records.
 */
function evalPropertyAccess(
	node: PropertyAccessExpression,
	visited: Set<Node>,
): JsonLikeValue {
	const envRef = extractEnvRef(node);
	if (envRef) return envRef;
	const root = node.getExpression();
	const propName = node.getName();
	if (Node.isIdentifier(root)) {
		for (const d of root.getDefinitionNodes()) {
			if (Node.isVariableDeclaration(d)) {
				const init = d.getInitializer();
				if (!init) continue;
				const evaluated = evalWithVisited(init, visited);
				if (isPlainRecord(evaluated) && propName in evaluated) {
					return evaluated[propName];
				}
			}
		}
	}
	return unevaluated(node);
}

/** Best-effort: resolve an identifier to an `as const` literal in the same file. */
function evalIdentifier(node: Identifier, visited: Set<Node>): JsonLikeValue {
	for (const d of node.getDefinitionNodes()) {
		if (Node.isVariableDeclaration(d)) {
			const init = d.getInitializer();
			if (init) return evalWithVisited(init, visited);
		}
	}
	return unevaluated(node);
}

function unevaluated(node: Node): UnevaluatedExpression {
	return { unevaluated: true, expression: node.getText() };
}

export function isUnevaluated(v: JsonLikeValue): v is UnevaluatedExpression {
	return (
		typeof v === "object" &&
		v !== null &&
		!Array.isArray(v) &&
		(v as { unevaluated?: unknown }).unevaluated === true
	);
}

export function isEnvRef(v: JsonLikeValue): v is EnvRef {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	if (isUnevaluated(v)) return false;
	const obj = v as { env?: unknown; default?: unknown };
	// An EnvRef has EXACTLY two keys: `env` (string) and `default`. A
	// user config like `{ env: 'production', port: 3000 }` happens to
	// contain `env` but isn't an env ref — the strict-shape check
	// avoids false positives.
	if (typeof obj.env !== "string") return false;
	const keys = Object.keys(obj);
	return keys.length === 2 && keys.includes("env") && keys.includes("default");
}

export function isPlainRecord(
	v: JsonLikeValue,
): v is { [k: string]: JsonLikeValue } {
	return (
		typeof v === "object" &&
		v !== null &&
		!Array.isArray(v) &&
		!isUnevaluated(v) &&
		!isEnvRef(v)
	);
}

/**
 * Detect `process.env.X` (PropertyAccessExpression) and
 * `env('X', default)` (CallExpression). Returns `null` if the node
 * isn't a recognized env ref.
 */
export function extractEnvRef(node: Node): EnvRef | null {
	if (Node.isPropertyAccessExpression(node)) {
		const obj = node.getExpression().getText();
		if (obj === "process.env") {
			return { env: node.getName(), default: null };
		}
		return null;
	}
	if (Node.isCallExpression(node)) {
		const callee = node.getExpression().getText();
		if (callee !== "env") return null;
		const args = node.getArguments();
		const first = args[0];
		if (!first) return null;
		const name = evaluateLiteral(first);
		if (typeof name !== "string") return null;
		const defaultArg = args[1];
		const def = defaultArg ? evaluateLiteral(defaultArg) : null;
		return { env: name, default: def };
	}
	return null;
}

/**
 * Best-effort symbol lookup. Walks every source file collecting
 * matching declarations, then prefers production paths over
 * `tests/` or `__tests__/`. When two production paths tie, the
 * caller can read `ambiguous` to surface the conflict in
 * `knownGaps`.
 */
export interface SymbolSite {
	name: string;
	kind: "class" | "function" | "interface" | "type";
	file: string;
	line: number;
	signature: string;
	ambiguous?: boolean;
}

const TEST_PATH = /\/(tests?|__tests__)\//;

export function findSymbol(
	project: Project,
	symbolName: string,
): SymbolSite | null {
	const matches: SymbolSite[] = [];
	for (const sf of project.getSourceFiles()) {
		const path = sf.getFilePath();
		if (path.endsWith(".d.ts")) continue;
		if (path.includes("/node_modules/")) continue;

		for (const cls of sf.getClasses()) {
			if (cls.getName() === symbolName) {
				matches.push({
					name: symbolName,
					kind: "class",
					file: path,
					line: cls.getStartLineNumber(),
					signature: firstLine(cls.getText()),
				});
			}
		}
		for (const fn of sf.getFunctions()) {
			if (fn.getName() === symbolName) {
				matches.push({
					name: symbolName,
					kind: "function",
					file: path,
					line: fn.getStartLineNumber(),
					signature: firstLine(fn.getText()),
				});
			}
		}
		for (const iface of sf.getInterfaces()) {
			if (iface.getName() === symbolName) {
				matches.push({
					name: symbolName,
					kind: "interface",
					file: path,
					line: iface.getStartLineNumber(),
					signature: firstLine(iface.getText()),
				});
			}
		}
		for (const t of sf.getTypeAliases()) {
			if (t.getName() === symbolName) {
				matches.push({
					name: symbolName,
					kind: "type",
					file: path,
					line: t.getStartLineNumber(),
					signature: firstLine(t.getText()),
				});
			}
		}
	}
	if (matches.length === 0) return null;
	const production = matches.filter((m) => !TEST_PATH.test(m.file));
	const candidates = production.length > 0 ? production : matches;
	const head = candidates[0] as SymbolSite;
	return candidates.length > 1 ? { ...head, ambiguous: true } : head;
}

function firstLine(s: string): string {
	const nl = s.indexOf("\n");
	return nl === -1 ? s : s.slice(0, nl);
}

/**
 * Test-only helper: drop every cached project. Production callers
 * should rely on tsconfig-mtime invalidation instead.
 */
export function resetCache(): void {
	CACHE.clear();
}
