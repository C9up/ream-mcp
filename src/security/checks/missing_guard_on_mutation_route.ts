/**
 * `missing_guard_on_mutation_route` check (Story 33.7).
 *
 * Flags controller methods decorated with a state-mutating HTTP
 * verb (`@Post`/`@Put`/`@Patch`/`@Delete`) that lack any auth /
 * authorization guard decorator on either the method itself OR
 * the enclosing class.
 *
 * Recognised guard decorators:
 *   - `@UseGuards`
 *   - `@Auth`, `@AuthGuard`, `@Authorize`, `@RequireAuth`
 *   - `@Roles`, `@RequireRoles`
 *
 * Scope: only fires on classes that look like controllers —
 * either the file path contains `/controllers/` OR the class
 * carries a `@Controller` / `@inject` / `@Service` decorator.
 * A generic class `class FormBuilder { @Post help() {} }` where
 * `Post` is unrelated to HTTP would otherwise false-positive.
 *
 * Heuristic, not data-flow: a class-level `@UseGuards` covers
 * every method on the class, so any guard decorator on the
 * class skips the check for its methods.
 */

import type { ClassDeclaration, MethodDeclaration } from "ts-morph";
import { excerpt, lineOf } from "./_helpers.js";
import type { CheckDefinition, RawFinding } from "./_types.js";

const MUTATION_DECORATORS = new Set(["Post", "Put", "Patch", "Delete"]);
const GUARD_DECORATORS = new Set([
	"UseGuards",
	"Auth",
	"AuthGuard",
	"Authorize",
	"RequireAuth",
	"Roles",
	"RequireRoles",
]);
const CONTROLLER_DECORATORS = new Set(["Controller", "inject", "Service"]);

export const missingGuardOnMutationRoute: CheckDefinition = {
	id: "missing_guard_on_mutation_route",
	severity: "high",
	hint: "decorate the controller class or method with `@UseGuards(AuthGuard)` (or an equivalent role-aware guard) so mutation routes cannot be reached anonymously.",
	docsUrl: "docs:/security/route-guards.md",
	run(ctx) {
		const findings: RawFinding[] = [];
		const inControllersDir = ctx.relPath
			.replace(/\\/g, "/")
			.includes("/controllers/");
		for (const cls of ctx.sf.getClasses()) {
			if (!isControllerClass(cls, inControllersDir)) continue;
			if (hasGuardDecorator(cls)) continue;
			for (const method of cls.getMethods()) {
				const verb = mutationVerbOf(method);
				if (!verb) continue;
				if (hasGuardDecorator(method)) continue;
				const line = lineOf(method);
				findings.push({
					check: "missing_guard_on_mutation_route",
					line,
					excerpt: excerpt(ctx.sf, line),
				});
			}
		}
		return findings;
	},
};

function isControllerClass(
	cls: ClassDeclaration,
	inControllersDir: boolean,
): boolean {
	if (inControllersDir) return true;
	for (const dec of cls.getDecorators()) {
		if (CONTROLLER_DECORATORS.has(dec.getName())) return true;
	}
	return false;
}

function mutationVerbOf(method: MethodDeclaration): string | null {
	for (const dec of method.getDecorators()) {
		const name = dec.getName();
		if (MUTATION_DECORATORS.has(name)) return name;
	}
	return null;
}

function hasGuardDecorator(
	target: ClassDeclaration | MethodDeclaration,
): boolean {
	for (const dec of target.getDecorators()) {
		if (GUARD_DECORATORS.has(dec.getName())) return true;
	}
	return false;
}
