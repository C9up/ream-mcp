/**
 * `reflect_metadata_missing` check (Story 33.7).
 *
 * The decorator-driven DI container the framework uses depends
 * on the `reflect-metadata` polyfill being imported BEFORE any
 * decorator-using module is evaluated. The contract is "import
 * it at the top of the entry file so it runs before container
 * construction".
 *
 * Heuristic (semantic): use ts-morph's import-declaration list
 * for the entry file's first 50 lines and check whether any
 * import resolves to `reflect-metadata` (or `core-js/reflect`).
 * Robust against block comments, line comments, and CJS
 * `require(...)` quirks the regex was missing.
 *
 * Project-level check (not file-level): runs only when the
 * dispatcher detects this source file is the entry. The
 * dispatcher passes a hint via `ctx.entryFile`. Priority:
 * `src/main.ts` → `src/index.ts` → `src/bootstrap.ts` →
 * `main.ts` → `index.ts`.
 */

import { excerpt } from "./_helpers.js";
import type { CheckDefinition, RawFinding } from "./_types.js";

const REFLECT_SPECIFIERS = new Set(["reflect-metadata", "core-js/reflect"]);
const REQUIRE_PATTERN =
	/^\s*(?:const|let|var)\s+[^=]+=\s*require\(\s*["'](reflect-metadata|core-js\/reflect)["']\s*\)/m;
const HEAD_LINES = 50;

export const reflectMetadataMissing: CheckDefinition = {
	id: "reflect_metadata_missing",
	severity: "medium",
	hint: 'add `import "reflect-metadata";` as the FIRST line of the entry file so the polyfill loads before any decorator-using module is evaluated.',
	docsUrl: "docs:/security/reflect-metadata.md",
	run(ctx) {
		if (!ctx.entryFile) return [];
		const norm = ctx.relPath.replace(/\\/g, "/");
		if (norm !== ctx.entryFile) return [];

		// Semantic ESM check via ts-morph: catches every import form
		// regardless of comment placement — `import "x"`, `import * as
		// y from "x"`, `import { z } from "x"`. Restrict to
		// declarations within the first 50 lines so a late import
		// counts as missing (the polyfill must run first).
		for (const decl of ctx.sf.getImportDeclarations()) {
			if (decl.getStartLineNumber() > HEAD_LINES) break;
			const spec = decl.getModuleSpecifierValue();
			if (REFLECT_SPECIFIERS.has(spec)) return [];
		}

		// CJS fallback — regex match on the head text only.
		const head = ctx.sf
			.getFullText()
			.split("\n")
			.slice(0, HEAD_LINES)
			.join("\n");
		if (REQUIRE_PATTERN.test(head)) return [];

		const finding: RawFinding = {
			check: "reflect_metadata_missing",
			line: 1,
			excerpt: excerpt(ctx.sf, 1),
		};
		return [finding];
	},
};

/**
 * Resolve the project's entry file (forward-slash relative
 * path) using the documented priority order. Exposed for the
 * dispatcher to call once per scan.
 */
export function resolveEntryFile(
	exists: (relPath: string) => boolean,
): string | null {
	const candidates = [
		"src/main.ts",
		"src/index.ts",
		"src/bootstrap.ts",
		"main.ts",
		"index.ts",
	];
	for (const c of candidates) {
		if (exists(c)) return c;
	}
	return null;
}
