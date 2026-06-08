/**
 * `station.*` MCP tools.
 *
 * Static `defineResource(...)` scan via ts-morph. No app boot, no
 * @c9up/station runtime import — the dispatcher works from the user
 * source tree alone.
 */

import { Node, SyntaxKind } from "ts-morph";

import {
	findCallExpressions,
	isLoadError,
	loadProject,
} from "../util/ts-static-parser.js";
import { isStationTool, STATION_TOOLS } from "./station.descriptors.js";

export { isStationTool, STATION_TOOLS };

const RESOURCE_ACTIONS = ["list", "show", "create", "edit", "destroy"] as const;

type Confidence = "high" | "medium" | "low";

interface ResourceSite {
	name?: string;
	entity?: string;
	actions: string[];
	file: string;
	line: number;
	confidence: Confidence;
	notes: string[];
}

interface ShapedError {
	error: string;
	hint: string;
}

function shapeError(error: string, hint: string): ShapedError {
	return { error, hint };
}

export function dispatchStation(
	root: string,
	name: string,
	_args: Record<string, unknown> = {},
): unknown {
	const loaded = loadProject(root);
	if (isLoadError(loaded)) return shapeError(loaded.error, loaded.hint);
	switch (name) {
		case "station.list_resources":
			return listResources(loaded.project);
		default:
			return shapeError(
				`Unknown station tool: ${name}`,
				"This dispatcher only handles `station.list_resources`.",
			);
	}
}

function listResources(project: Parameters<typeof findCallExpressions>[0]) {
	const sites = findCallExpressions(
		project,
		(leaf) => leaf === "defineResource",
	);
	const resources = sites.map(parseResourceSite);
	return {
		resources,
		confidence:
			resources.length === 0 ? "high" : aggregateConfidence(resources),
		knownGaps:
			resources.length === 0
				? ["No defineResource() calls found in the project source tree."]
				: [],
	};
}

/** The lower of two confidence levels (high > medium > low). */
function worstConfidence(a: Confidence, b: Confidence): Confidence {
	const rank: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };
	return rank[a] <= rank[b] ? a : b;
}

/** Statically parse one `defineResource({...})` call site. */
function parseResourceSite(
	site: ReturnType<typeof findCallExpressions>[number],
): ResourceSite {
	const notes: string[] = [];
	const resource: ResourceSite = {
		actions: [...RESOURCE_ACTIONS],
		file: site.file,
		line: site.line,
		confidence: "high",
		notes,
	};

	const arg0 = site.expr.getArguments()[0];
	if (arg0 === undefined || !Node.isObjectLiteralExpression(arg0)) {
		notes.push(
			"defineResource called without an inline object literal — cannot statically resolve options",
		);
		resource.confidence = "low";
		return resource;
	}

	let confidence: Confidence = "high";
	for (const prop of arg0.getProperties()) {
		if (!Node.isPropertyAssignment(prop)) continue;
		const init = prop.getInitializer();
		if (init === undefined) continue;
		const key = prop.getName();
		if (key === "name") {
			confidence = worstConfidence(
				confidence,
				parseResourceName(init, resource, notes),
			);
		} else if (key === "entity") {
			confidence = worstConfidence(
				confidence,
				parseResourceEntity(init, resource, notes),
			);
		} else if (key === "actions") {
			confidence = worstConfidence(
				confidence,
				parseResourceActions(init, resource, notes),
			);
		}
	}

	if (resource.name === undefined && resource.entity !== undefined) {
		// defineResource() derives the name from the entity class via
		// kebab-case slugification. Static analysis can't run that
		// transform reliably without the runtime class, so flag medium
		// confidence and surface the entity reference as a fallback.
		confidence = confidence === "high" ? "medium" : confidence;
		notes.push(
			`name omitted — runtime derives kebab-case slug from entity (${resource.entity})`,
		);
	}
	resource.confidence = confidence;
	return resource;
}

/** Parse the `name` option; downgrades to medium when not a string literal. */
function parseResourceName(
	init: Node,
	resource: ResourceSite,
	notes: string[],
): Confidence {
	if (Node.isStringLiteral(init)) {
		resource.name = init.getLiteralValue();
		return "high";
	}
	notes.push("name is not a string literal");
	return "medium";
}

/** Parse the `entity` option; surfaces the reference even when not a bare identifier. */
function parseResourceEntity(
	init: Node,
	resource: ResourceSite,
	notes: string[],
): Confidence {
	resource.entity = init.getText();
	if (Node.isIdentifier(init)) return "high";
	notes.push("entity is not a bare identifier");
	return "medium";
}

/** Parse the `actions` option; keeps the literal entries, flags non-literals. */
function parseResourceActions(
	init: Node,
	resource: ResourceSite,
	notes: string[],
): Confidence {
	if (init.getKind() !== SyntaxKind.ArrayLiteralExpression) {
		notes.push("actions is not an inline array literal");
		return "medium";
	}
	const arr = init.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
	const elements: string[] = [];
	let confidence: Confidence = "high";
	for (const el of arr.getElements()) {
		if (Node.isStringLiteral(el)) {
			elements.push(el.getLiteralValue());
		} else {
			confidence = "medium";
			notes.push("actions array contains a non-literal entry");
		}
	}
	if (elements.length > 0) resource.actions = elements;
	return confidence;
}

function aggregateConfidence(sites: ResourceSite[]): Confidence {
	let worst: Confidence = "high";
	for (const s of sites) {
		if (s.confidence === "low") return "low";
		if (s.confidence === "medium") worst = "medium";
	}
	return worst;
}
