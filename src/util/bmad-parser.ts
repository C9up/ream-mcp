/**
 * BMAD `epics.md` heading walker — Story 33.8.
 *
 * Tokenises the file by ATX headings:
 *   - `## Epic N: <title>` (with optional emoji prefix and
 *     optional trailing status badge)
 *   - `### Story N.M: <title>` (same lenience)
 *
 * Format drift is reported through `parserWarnings` rather than
 * silently dropped. The `PARSER_VERSION` constant bumps when the
 * recognised forms change.
 */

export const PARSER_VERSION = "1.0.0";

export interface ParsedStory {
	id: string;
	epicId: string;
	storyNum: string;
	title: string;
	statusBadge: string | null;
	startLine: number;
	endLine: number;
}

export interface ParsedEpic {
	id: string;
	title: string;
	statusBadge: string | null;
	startLine: number;
	endLine: number;
	stories: ParsedStory[];
}

export interface ParseResult {
	parserVersion: string;
	parserWarnings: string[];
	epics: ParsedEpic[];
}

// Lenient ATX heading match. Captures: indent, level, optional
// emoji/symbol prefix, the literal `Epic`/`Story` keyword, the
// numeric id, the title, and an optional trailing status badge
// in square brackets. Strips leading symbols that are NOT word
// characters (emoji, dingbats, e.g. `🚀`).
const HEADING =
	/^(\s*)(##+)\s+(?:([^A-Za-z\s]+)\s+)?(Epic|Story)\s+(\S+?):\s+(.*?)(?:\s+\[([^\]]*)\])?\s*$/;

const STORY_ID = /^(\d+)\.(\d+)$/;
const EPIC_ID = /^(\d+)$/;

export function parseEpicsFile(text: string): ParseResult {
	const lines = text.split("\n");
	const epics: ParsedEpic[] = [];
	const warnings: string[] = [];
	let currentEpic: ParsedEpic | null = null;
	let currentStory: ParsedStory | null = null;

	const closeStory = (endLine: number): void => {
		if (currentStory !== null) {
			currentStory.endLine = endLine;
			currentStory = null;
		}
	};
	const closeEpic = (endLine: number): void => {
		closeStory(endLine);
		if (currentEpic !== null) {
			currentEpic.endLine = endLine;
			currentEpic = null;
		}
	};

	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const lineNumber = i + 1;
		const line = lines[i];

		// Track fenced code-block state so a quoted `## Epic 99: ...`
		// inside ``` ``` ``` is not parsed as a real heading.
		if (/^\s*(?:```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		// Skip non-heading lines fast.
		if (!line.startsWith("#") && !/^\s+#/.test(line)) continue;

		const match = HEADING.exec(line);
		if (!match) {
			// A heading-shaped line we cannot parse — surface it as a
			// warning rather than silent drop, but only when the line
			// looks heading-like (`## `/`### `).
			if (/^\s*#{2,3}\s/.test(line)) {
				if (/\b(Epic|Story)\b/i.test(line)) {
					warnings.push(
						`line ${lineNumber}: heading mentions Epic/Story but does not match expected form: ${line.trim()}`,
					);
				}
			}
			continue;
		}

		const [, , hashes, , kind, idText, title, badgeRaw] = match;
		const level = hashes.length;
		const badge = badgeRaw === undefined ? null : badgeRaw;

		if (kind === "Epic") {
			if (level !== 2) {
				warnings.push(
					`line ${lineNumber}: Epic heading at level ${level}, expected level 2`,
				);
				continue;
			}
			const idMatch = EPIC_ID.exec(idText);
			if (!idMatch) {
				warnings.push(
					`line ${lineNumber}: Epic id "${idText}" is not a positive integer`,
				);
				continue;
			}
			closeEpic(lineNumber - 1);
			currentEpic = {
				id: idMatch[1],
				title: title.trim(),
				statusBadge: badge,
				startLine: lineNumber,
				endLine: lineNumber,
				stories: [],
			};
			epics.push(currentEpic);
			continue;
		}

		// kind === "Story"
		if (level !== 3) {
			warnings.push(
				`line ${lineNumber}: Story heading at level ${level}, expected level 3`,
			);
			continue;
		}
		const idMatch = STORY_ID.exec(idText);
		if (!idMatch) {
			warnings.push(
				`line ${lineNumber}: Story id "${idText}" is not in N.M form`,
			);
			continue;
		}
		const epicId = idMatch[1];
		const storyNum = idMatch[2];
		const fullId = `${epicId}.${storyNum}`;

		if (currentEpic === null || currentEpic.id !== epicId) {
			warnings.push(
				`line ${lineNumber}: Story ${fullId} has no preceding Epic ${epicId} heading; orphan ignored`,
			);
			continue;
		}

		closeStory(lineNumber - 1);
		currentStory = {
			id: fullId,
			epicId,
			storyNum,
			title: title.trim(),
			statusBadge: badge,
			startLine: lineNumber,
			endLine: lineNumber,
		};
		currentEpic.stories.push(currentStory);
	}

	closeEpic(lines.length);

	// Determinism: sort epics by numeric id, stories by numeric story
	// number within each epic.
	epics.sort((a, b) => Number(a.id) - Number(b.id));
	for (const epic of epics) {
		epic.stories.sort((a, b) => Number(a.storyNum) - Number(b.storyNum));
	}

	return {
		parserVersion: PARSER_VERSION,
		parserWarnings: warnings,
		epics,
	};
}

/**
 * Slice the body of an epic or story section out of the raw text.
 * Returns the text from the heading line up to (but not including)
 * the next sibling-or-higher heading. Used by `bmad.get_story` for
 * the epic-section fallback.
 */
export function sliceSection(
	text: string,
	startLine: number,
	endLine: number,
): string {
	const lines = text.split("\n");
	const start = Math.max(0, startLine - 1);
	const end = Math.min(lines.length, endLine);
	return lines.slice(start, end).join("\n");
}
