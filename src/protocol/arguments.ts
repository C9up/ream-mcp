/**
 * Checks a `tools/call`'s arguments against the tool's `inputSchema` before
 * the tool runs, so a handler only ever sees arguments of the shape it
 * advertised.
 *
 * Only the JSON Schema keywords the tool descriptors use are understood:
 * {@link SUPPORTED_KEYWORDS}. A descriptor that uses another keyword fails a
 * unit test rather than being silently half-checked here.
 */

import { isJsonObject } from "./jsonrpc.js";

export const SUPPORTED_KEYWORDS = new Set([
	"type",
	"properties",
	"required",
	"additionalProperties",
	"enum",
	"minimum",
	"maximum",
	"pattern",
	"items",
	"default",
	"description",
]);

/** At most this many problems are reported for one call. */
const MAX_PROBLEMS = 20;

function typeMatches(type: unknown, value: unknown): boolean {
	switch (type) {
		case "object":
			return isJsonObject(value);
		case "array":
			return Array.isArray(value);
		case "string":
			return typeof value === "string";
		case "boolean":
			return typeof value === "boolean";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		default:
			// A schema with no `type` accepts any value.
			return type === undefined;
	}
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function check(
	schema: unknown,
	value: unknown,
	path: string,
	problems: string[],
): void {
	if (problems.length >= MAX_PROBLEMS || !isJsonObject(schema)) return;
	const at = path === "" ? "arguments" : path;
	if (!typeMatches(schema.type, value)) {
		problems.push(
			`${at} must be ${String(schema.type)}, got ${describe(value)}`,
		);
		return;
	}
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		problems.push(
			`${at} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`,
		);
	}
	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) {
			problems.push(`${at} must be >= ${schema.minimum}`);
		}
		if (typeof schema.maximum === "number" && value > schema.maximum) {
			problems.push(`${at} must be <= ${schema.maximum}`);
		}
	}
	if (typeof value === "string" && typeof schema.pattern === "string") {
		if (!new RegExp(schema.pattern, "u").test(value)) {
			problems.push(`${at} must match ${schema.pattern}`);
		}
	}
	if (Array.isArray(value) && schema.items !== undefined) {
		value.forEach((item, index) => {
			check(schema.items, item, `${at}[${index}]`, problems);
		});
	}
	if (isJsonObject(value)) {
		const properties = isJsonObject(schema.properties) ? schema.properties : {};
		if (Array.isArray(schema.required)) {
			for (const key of schema.required) {
				if (typeof key === "string" && !Object.hasOwn(value, key)) {
					problems.push(`${path === "" ? "" : `${path}.`}${key} is required`);
				}
			}
		}
		for (const [key, item] of Object.entries(value)) {
			const where = path === "" ? key : `${path}.${key}`;
			if (Object.hasOwn(properties, key)) {
				check(properties[key], item, where, problems);
			} else if (schema.additionalProperties === false) {
				problems.push(`${where} is not an accepted argument`);
			} else if (isJsonObject(schema.additionalProperties)) {
				check(schema.additionalProperties, item, where, problems);
			}
		}
	}
}

/** The problems with `args`, empty when they fit `schema`. */
export function validateArguments(schema: unknown, args: unknown): string[] {
	const problems: string[] = [];
	check(schema, args, "", problems);
	return problems;
}

/** Every keyword `schema` uses, nested schemas included. */
export function schemaKeywords(
	schema: unknown,
	out = new Set<string>(),
): Set<string> {
	if (!isJsonObject(schema)) return out;
	for (const key of Object.keys(schema)) out.add(key);
	if (isJsonObject(schema.properties)) {
		for (const nested of Object.values(schema.properties)) {
			schemaKeywords(nested, out);
		}
	}
	schemaKeywords(schema.items, out);
	schemaKeywords(schema.additionalProperties, out);
	return out;
}
