/**
 * Find the class an identifier names, across the files of a Ream
 * application, without a type checker.
 *
 * The security checks run on a ts-morph `Project` that does not resolve
 * dependencies, so a route's `[UsersController, 'store']` is only a name.
 * This follows that name the way the application wrote it: a class of the
 * same file, an `import` (relative, or one of the package's `#` subpath
 * imports such as `#controllers/*`), or the lazy
 * `const UsersController = () => import('#controllers/users_controller')`
 * form. A bare package specifier is not followed: it is not the
 * application's code.
 *
 * Every read goes through the project's file system, so it works the same
 * on disk and in an in-memory project.
 */

import { posix } from "node:path";

import {
	type ClassDeclaration,
	Node,
	type Project,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";

import { isRecord } from "../../util/guards.js";

/** A class found, or why it was not. */
export type ClassLookup =
	| { kind: "found"; cls: ClassDeclaration }
	| { kind: "unresolved"; reason: string };

/** Forward slashes, so `posix` path arithmetic holds on Windows too. */
function slashes(path: string): string {
	return path.replace(/\\/g, "/");
}

/** The class `name` refers to from `sf`. */
export function resolveClass(
	project: Project,
	root: string,
	sf: SourceFile,
	name: string,
): ClassLookup {
	const local = sf.getClass(name);
	if (local) return { kind: "found", cls: local };

	for (const decl of sf.getImportDeclarations()) {
		const spec = decl.getModuleSpecifierValue();
		if (decl.getDefaultImport()?.getText() === name) {
			return classOfModule(project, root, sf, spec, "default");
		}
		for (const named of decl.getNamedImports()) {
			const local = named.getAliasNode()?.getText() ?? named.getName();
			if (local === name) {
				return classOfModule(project, root, sf, spec, named.getName());
			}
		}
	}

	const lazy = lazyImportSpecifier(sf, name);
	if (lazy !== null) return classOfModule(project, root, sf, lazy, "default");

	return {
		kind: "unresolved",
		reason: `'${name}' is not declared or imported`,
	};
}

/**
 * The specifier of `const name = () => import('spec')`, or `null` when
 * `name` is not declared that way.
 */
export function lazyImportSpecifier(
	sf: SourceFile,
	name: string,
): string | null {
	const init = sf.getVariableDeclaration(name)?.getInitializer();
	return init ? dynamicImportSpecifier(init) : null;
}

/** The specifier of `() => import('spec')`, or `null` for any other node. */
export function dynamicImportSpecifier(node: Node): string | null {
	if (!Node.isArrowFunction(node) && !Node.isFunctionExpression(node)) {
		return null;
	}
	let body: Node | undefined = node.getBody();
	if (Node.isBlock(body)) {
		const ret = body.getStatements().find(Node.isReturnStatement);
		body = ret?.getExpression();
	}
	if (!body || !Node.isCallExpression(body)) return null;
	if (body.getExpression().getKind() !== SyntaxKind.ImportKeyword) return null;
	const [arg] = body.getArguments();
	if (
		arg &&
		(Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))
	) {
		return arg.getLiteralValue();
	}
	return null;
}

/** The class a module exports as `exportName` (`"default"` for the default export). */
export function classOfModule(
	project: Project,
	root: string,
	from: SourceFile,
	spec: string,
	exportName: string,
): ClassLookup {
	const target = loadModule(project, root, from, spec);
	if (target === null) {
		return { kind: "unresolved", reason: `cannot resolve '${spec}'` };
	}
	const cls = exportedClass(target, exportName);
	if (cls) return { kind: "found", cls };
	return {
		kind: "unresolved",
		reason: `'${spec}' exports no class as ${exportName}`,
	};
}

function exportedClass(
	sf: SourceFile,
	exportName: string,
): ClassDeclaration | undefined {
	if (exportName !== "default") {
		const cls = sf.getClass(exportName);
		return cls?.isExported() ? cls : undefined;
	}
	const declared = sf.getClasses().find((c) => c.isDefaultExport());
	if (declared) return declared;
	// `class UsersController {}` … `export default UsersController`
	const assignment = sf.getExportAssignment((a) => !a.isExportEquals());
	const expr = assignment?.getExpression();
	return expr && Node.isIdentifier(expr)
		? sf.getClass(expr.getText())
		: undefined;
}

/** The source file `spec` names from `from`, or `null` when it cannot be found. */
function loadModule(
	project: Project,
	root: string,
	from: SourceFile,
	spec: string,
): SourceFile | null {
	const fromDir = posix.dirname(slashes(from.getFilePath()));
	let base: string | null = null;
	if (spec.startsWith("./") || spec.startsWith("../")) {
		base = posix.join(fromDir, spec);
	} else if (spec.startsWith("#")) {
		base = resolveSubpathImport(project, slashes(root), fromDir, spec);
	}
	if (base === null) return null;
	// A relative import that climbs out of the project is not its code: the
	// scan does not read files outside the root it was given.
	const rootDir = slashes(root).replace(/\/$/, "");
	if (!posix.normalize(base).startsWith(`${rootDir}/`)) return null;
	for (const candidate of candidates(base)) {
		const existing = project.getSourceFile(candidate);
		if (existing) return existing;
		const added = project.addSourceFileAtPathIfExists(candidate);
		if (added) return added;
	}
	return null;
}

/** The TypeScript files a specifier written for the emitted JavaScript stands for. */
function candidates(base: string): string[] {
	if (/\.[cm]?js$/.test(base)) {
		const stem = base.replace(/\.([cm]?)js$/, ".$1ts");
		return [stem, base.replace(/\.[cm]?js$/, ".tsx"), base];
	}
	if (/\.tsx?$/.test(base)) return [base];
	return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
}

/**
 * Resolve `#controllers/users_controller` through the `imports` field of the
 * nearest `package.json` between the importing file and the project root.
 */
function resolveSubpathImport(
	project: Project,
	root: string,
	fromDir: string,
	spec: string,
): string | null {
	const fs = project.getFileSystem();
	let dir = fromDir;
	for (;;) {
		const manifest = posix.join(dir, "package.json");
		if (fs.fileExistsSync(manifest)) {
			return matchImports(readImports(fs.readFileSync(manifest)), dir, spec);
		}
		if (dir === root || !dir.startsWith(`${root}/`)) return null;
		const parent = posix.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function readImports(text: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(text);
		if (isRecord(parsed) && isRecord(parsed.imports)) return parsed.imports;
	} catch {
		// An unreadable manifest resolves nothing.
	}
	return {};
}

function matchImports(
	imports: Record<string, unknown>,
	pkgDir: string,
	spec: string,
): string | null {
	for (const [key, value] of Object.entries(imports)) {
		const target = conditionTarget(value);
		if (target === null) continue;
		const star = key.indexOf("*");
		if (star === -1) {
			if (key === spec) return posix.join(pkgDir, target);
			continue;
		}
		const prefix = key.slice(0, star);
		const suffix = key.slice(star + 1);
		if (
			spec.length >= prefix.length + suffix.length &&
			spec.startsWith(prefix) &&
			spec.endsWith(suffix)
		) {
			const middle = spec.slice(prefix.length, spec.length - suffix.length);
			return posix.join(pkgDir, target.replace("*", middle));
		}
	}
	return null;
}

/** The path of an `imports` entry: a string, or the condition Node would pick. */
function conditionTarget(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return null;
	for (const condition of ["node", "import", "default"]) {
		const target = conditionTarget(value[condition]);
		if (target !== null) return target;
	}
	return null;
}
