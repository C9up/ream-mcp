/**
 * `cookie_missing_flags` check.
 *
 * Flags a Ream response cookie that ends up without `Secure`, `SameSite` or
 * `HttpOnly`:
 *
 *     response.cookie('session', token, { secure: false })           // explicit downgrade
 *     response.encryptedCookie('cart', cart, { httpOnly: false })
 *     response.cookie('a', v, { sameSite: undefined })               // drops the default
 *     export const http = { cookie: { secure: false } }              // config/app.ts
 *
 * What a cookie gets depends on the ream version the application runs
 * (`./_project.ts`):
 *
 *   - from 0.2.32, every cookie gets `Secure`, `SameSite=lax` and `HttpOnly`
 *     unless the call passes its own value, and the application changes these
 *     defaults under `http.cookie` in `config/app.ts`. A call that leaves the
 *     flags out is fine; a `false` (or an explicit `undefined`, which drops a
 *     default) is a finding, on the call or in `http.cookie`;
 *   - before 0.2.32, a cookie gets `HttpOnly` only: a call must pass
 *     `secure` and `sameSite` itself. When the version is unknown, the check
 *     reads the application this way and says so in `knownGaps`.
 *
 * A write takes a name and a value, so a call with fewer than two arguments
 * is a read (`request.cookie('session')`), and a receiver named `request`
 * is never a write. `clearCookie` expires a cookie and is not checked.
 * Options passed as a variable are skipped, and with a spread
 * (`{ ...cookieDefaults, maxAge: 1 }`) only the flags written out are read:
 * the others may be in the spread (false negative tolerated). A flag set to
 * an expression (`secure: app.inProduction`) counts as set.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	type Expression,
	Node,
	type ObjectLiteralExpression,
	Project,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";
import { realpathInside } from "../../util/containment.js";
import { excerpt, lineOf } from "./_helpers.js";
import {
	type ProjectFacts,
	pushGapOnce,
	REAM_SECURE_DEFAULTS,
	reamAtLeast,
	versionGap,
} from "./_project.js";
import type { CheckContext, CheckDefinition, RawFinding } from "./_types.js";

const WRITERS = new Set(["cookie", "plainCookie", "encryptedCookie"]);
const FLAGS = ["secure", "sameSite", "httpOnly"] as const;
type Flag = (typeof FLAGS)[number];
/** The flags a ream before 0.2.32 left out unless the call passed them. */
const FLAGS_WITHOUT_OLD_DEFAULT: readonly Flag[] = ["secure", "sameSite"];
const APP_CONFIG = /^config\/app\.tsx?$/;

export const cookieMissingFlags: CheckDefinition = {
	id: "cookie_missing_flags",
	severity: "low",
	hint: "never set `secure: false`, `sameSite: false` or `httpOnly: false` (or `undefined`, which drops the default) on a `response.cookie()` / `plainCookie()` / `encryptedCookie()` call or under `http.cookie` in `config/app.ts`. From ream 0.2.32 every cookie gets `Secure`, `SameSite=lax` and `HttpOnly` by default; before it ream adds only `HttpOnly`, so each call must pass `{ secure: true, sameSite: 'lax' }` (or upgrade).",
	docsUrl: "https://reamjs.com/en/guides/basics/response",
	run(ctx) {
		const findings: RawFinding[] = [];
		const record = (target: Node): void => {
			const line = lineOf(target);
			findings.push({
				check: "cookie_missing_flags",
				line,
				excerpt: excerpt(ctx.sf, line),
			});
		};
		if (APP_CONFIG.test(ctx.relPath)) {
			const block = httpCookieBlock(ctx.sf);
			if (block !== null && block !== "unreadable") {
				const lines = new Set<number>();
				for (const flag of FLAGS) {
					const value = literalOption(block, flag);
					// In `http.cookie`, `undefined` leaves the default in place.
					if (value?.getKind() !== SyntaxKind.FalseKeyword) continue;
					if (lines.has(lineOf(value))) continue;
					lines.add(lineOf(value));
					record(value);
				}
			}
		}
		ctx.sf.forEachDescendant((node) => {
			if (!Node.isCallExpression(node)) return;
			const callee = node.getExpression();
			if (!Node.isPropertyAccessExpression(callee)) return;
			if (!WRITERS.has(callee.getName())) return;
			if (/(^|\.)request$/.test(callee.getExpression().getText())) return;
			const args = node.getArguments();
			if (args.length < 2) return;
			const opts = args[2];
			if (opts !== undefined && !Node.isObjectLiteralExpression(opts)) return;
			if (writesWeakCookie(ctx, opts)) record(node);
		});
		return findings;
	},
};

/** Whether a write with these options ends up without one of the flags. */
function writesWeakCookie(
	ctx: CheckContext,
	opts: ObjectLiteralExpression | undefined,
): boolean {
	const spread = opts?.getProperties().some(Node.isSpreadAssignment) ?? false;
	for (const flag of FLAGS) {
		const value = opts === undefined ? null : literalOption(opts, flag);
		if (value !== null) {
			if (dropsFlag(value)) return true;
			continue;
		}
		if (opts !== undefined && namesOption(opts, flag)) continue;
		if (spread) continue;
		if (!defaultCovers(ctx, flag)) return true;
	}
	return false;
}

/** `false`, or `undefined`, which drops the default for this one call. */
function dropsFlag(value: Expression): boolean {
	return (
		value.getKind() === SyntaxKind.FalseKeyword ||
		(Node.isIdentifier(value) && value.getText() === "undefined")
	);
}

/** Whether the defaults give a cookie written without `flag` that flag. */
function defaultCovers(ctx: CheckContext, flag: Flag): boolean {
	if (!FLAGS_WITHOUT_OLD_DEFAULT.includes(flag)) return true;
	const secureDefaults = reamAtLeast(ctx.facts, REAM_SECURE_DEFAULTS);
	if (secureDefaults === null) {
		pushGapOnce(ctx.knownGaps, versionGap("cookie defaults"));
	}
	if (secureDefaults !== true) return false;
	// The application may have changed the default; a `false` there is
	// reported on `config/app.ts` itself, once.
	if (appCookieBlock(ctx) === "unreadable") {
		pushGapOnce(
			ctx.knownGaps,
			"cookie_missing_flags: http.cookie in config/app.ts is not a literal object; the cookie defaults it sets were not checked",
		);
	}
	return true;
}

/** The initializer of `name` when written as `name: value`; null otherwise. */
function literalOption(
	opts: ObjectLiteralExpression,
	name: string,
): Expression | null {
	const prop = opts.getProperty(name);
	if (!prop || !Node.isPropertyAssignment(prop)) return null;
	return prop.getInitializer() ?? null;
}

/** Whether `name` is set in any other form (shorthand, method, accessor). */
function namesOption(opts: ObjectLiteralExpression, name: string): boolean {
	return opts.getProperty(name) !== undefined;
}

// ------------------------------------------------------------ config/app.ts

type CookieBlock = ObjectLiteralExpression | "unreadable" | null;

const appBlocks = new WeakMap<ProjectFacts, CookieBlock>();

/** The application's `http.cookie` block, read once per scan. */
function appCookieBlock(ctx: CheckContext): CookieBlock {
	const known = appBlocks.get(ctx.facts);
	if (known !== undefined) return known;
	const block = readAppCookieBlock(ctx.root);
	appBlocks.set(ctx.facts, block);
	return block;
}

function readAppCookieBlock(root: string): CookieBlock {
	for (const name of ["app.ts", "app.tsx"]) {
		const path = realpathInside(join(root, "config", name), root);
		if (path === null) continue;
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			return "unreadable";
		}
		const project = new Project({
			useInMemoryFileSystem: true,
			skipFileDependencyResolution: true,
			skipAddingFilesFromTsConfig: true,
		});
		return httpCookieBlock(project.createSourceFile(`/${name}`, text));
	}
	return null;
}

/**
 * `http.cookie` of a `config/app.ts`: `export const http = { cookie }` or
 * `export default { http: { cookie } }`, through `defineConfig(…)`,
 * `satisfies` and `as`. `null` when there is none, `"unreadable"` when it is
 * not a literal the check can read.
 */
function httpCookieBlock(sf: SourceFile): CookieBlock {
	let http: Node | undefined;
	const declared = sf.getVariableDeclaration("http");
	if (declared?.isExported()) http = declared.getInitializer();
	if (http === undefined) {
		const assignment = sf.getExportAssignment((a) => !a.isExportEquals());
		if (assignment) {
			const config = unwrap(assignment.getExpression());
			if (!Node.isObjectLiteralExpression(config)) return "unreadable";
			const prop = config.getProperty("http");
			if (!prop) return null;
			if (!Node.isPropertyAssignment(prop)) return "unreadable";
			http = prop.getInitializer();
		}
	}
	if (http === undefined) return null;
	const httpObject = unwrap(http);
	if (!Node.isObjectLiteralExpression(httpObject)) return "unreadable";
	if (httpObject.getProperties().some(Node.isSpreadAssignment)) {
		return "unreadable";
	}
	const cookie = httpObject.getProperty("cookie");
	if (!cookie) return null;
	if (!Node.isPropertyAssignment(cookie)) return "unreadable";
	const init = cookie.getInitializer();
	const block = init ? unwrap(init) : undefined;
	if (!block || !Node.isObjectLiteralExpression(block)) return "unreadable";
	if (block.getProperties().some(Node.isSpreadAssignment)) return "unreadable";
	return block;
}

/** The object under `defineConfig(…)`, `satisfies`, `as` and parentheses. */
function unwrap(node: Node): Node {
	let current = node;
	for (;;) {
		if (
			Node.isSatisfiesExpression(current) ||
			Node.isAsExpression(current) ||
			Node.isParenthesizedExpression(current)
		) {
			current = current.getExpression();
			continue;
		}
		if (Node.isCallExpression(current)) {
			const [first] = current.getArguments();
			if (first && Node.isObjectLiteralExpression(first)) return first;
		}
		return current;
	}
}
