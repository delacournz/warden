import type { Rect } from "../driver/driver.types";
import type { NodeEntry, NodeIndex } from "./nodes";
import type { ReactMatch } from "./react-locator";
import { normalizeText } from "./text";

/**
 * How far apart (points, per edge) a React rect and an accessibility frame may be and still be one view: React measures
 * in fractional points, the AX frame is rounded.
 */
const EDGE_SLACK = 1.5;

function sameRect(a: Rect, b: Rect): boolean {
	if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
	return (
		Math.abs(a.x - b.x) <= EDGE_SLACK &&
		Math.abs(a.y - b.y) <= EDGE_SLACK &&
		Math.abs(a.x + a.width - (b.x + b.width)) <= EDGE_SLACK &&
		Math.abs(a.y + a.height - (b.y + b.height)) <= EDGE_SLACK
	);
}

function ownText(entry: NodeEntry): string {
	return normalizeText(entry.name ?? entry.value ?? "");
}

/**
 * The accessibility node a React component stands for on a degraded read: a fallback reader (iOS host `ax`) keeps the
 * node but drops its testID, so the component's rect is what ties the two. Never a node that carries another testID,
 * never an area-less rect. Several nodes with the rect: the one whose own text is the component's, else the deepest.
 */
export function nodeOfReactMatch(match: ReactMatch, index: NodeIndex): NodeEntry | undefined {
	const candidates = index.entries.filter((entry) => {
		const id = entry.element.identifier;
		return (id === undefined || id === match.testId) && sameRect(entry.element.frame, match.frame);
	});
	const text = match.text === undefined ? "" : normalizeText(match.text);
	const worded = text === "" ? [] : candidates.filter((entry) => ownText(entry) === text);
	const pool = worded.length > 0 ? worded : candidates;
	let best: NodeEntry | undefined;
	for (const entry of pool) if (best === undefined || entry.depth > best.depth) best = entry;
	return best;
}

/** The node of every match, each a different node; undefined when one of them has none (the React tree answers alone). */
export function mergeReactMatches(matches: readonly ReactMatch[], index: NodeIndex): NodeEntry[] | undefined {
	const entries: NodeEntry[] = [];
	for (const match of matches) {
		const entry = nodeOfReactMatch(match, index);
		if (entry === undefined || entries.includes(entry)) return undefined;
		entries.push(entry);
	}
	return entries;
}
