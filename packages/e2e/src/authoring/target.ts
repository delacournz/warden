import type { Element, Point, Snapshot } from "../driver/driver.types";
import { indexSnapshot, type NodeEntry, type NodeIndex } from "../screen/nodes";
import { formatSelector, matchesSelector, type ParsedSelector } from "../screen/selector";
import type { ChainEntry, CoordsTarget, Target } from "./recording.schema";

/** Turn an element the user pointed at into a durable target (never an `@ref`), degrading to coordinates. */

const DEFAULT_COORDS_WARNING = "recorded by coordinates; it will not survive a layout change";

function centre(element: Element): Point {
	return (
		element.tapPoint ?? { x: element.frame.x + element.frame.width / 2, y: element.frame.y + element.frame.height / 2 }
	);
}

export function coordsTarget(point: Point, warning: string = DEFAULT_COORDS_WARNING): CoordsTarget {
	return { kind: "coords", x: point.x, y: point.y, warning };
}

function text(value: string): { kind: "text"; value: string } {
	return { kind: "text", value };
}

function nonEmpty(value: string | undefined): string | undefined {
	return value === undefined || value === "" ? undefined : value;
}

/** Nodes matching `selector` (substring terms are loose, so this can be more than the one pointed at). */
function matchCount(index: NodeIndex, selector: ParsedSelector): number {
	return index.entries.filter((candidate) => matchesSelector(candidate, selector)).length;
}

/** `formatSelector(selector)`, plus `nth=` when other nodes match too. */
function pinned(index: NodeIndex, entry: NodeEntry, selector: ParsedSelector): string {
	const matches = index.entries.filter((candidate) => matchesSelector(candidate, selector));
	if (matches.length === 1 && matches[0] === entry) return formatSelector(selector);
	return formatSelector({ ...selector, nth: Math.max(0, matches.indexOf(entry)) });
}

type Candidate = { by: "id" | "role-label" | "role-text"; selector: ParsedSelector };

/** The selectors an element can be found by, most durable first: id, role+label, role+text (when it differs). */
function selectorCandidates(element: Element, role: { kind: "text"; value: string }): Candidate[] {
	const candidates: Candidate[] = [];
	const identifier = nonEmpty(element.identifier);
	if (identifier !== undefined) candidates.push({ by: "id", selector: { id: text(identifier) } });
	const label = nonEmpty(element.label);
	if (label !== undefined) candidates.push({ by: "role-label", selector: { role, label: text(label) } });
	const ownText = nonEmpty(element.text);
	if (ownText !== undefined && ownText !== label) {
		candidates.push({ by: "role-text", selector: { role, text: text(ownText) } });
	}
	return candidates;
}

/**
 * The resolved target for an element of `snapshot`: a selector chain (id → role+label → role+text → path) plus a landmark.
 * Never an `@ref`. An element that is not in the snapshot degrades to a coordinate target.
 */
export function targetFromElement(element: Element, snapshot: Snapshot): Target {
	const index = indexSnapshot(snapshot);
	const entry = index.byId.get(element.id);
	if (!entry) return coordsTarget(centre(element), "element was not in the snapshot; recorded by coordinates");

	const role = text(entry.role);
	const candidates = selectorCandidates(element, role);
	const chain: ChainEntry[] = candidates.map(({ by, selector }) => ({ by, selector: pinned(index, entry, selector) }));

	const sameRole = index.entries.filter((candidate) => candidate.role === entry.role);
	const primary = candidates[0];
	const selector =
		chain[0] && "selector" in chain[0] ? chain[0].selector : formatSelector({ role, nth: sameRole.indexOf(entry) });
	const matches = primary === undefined ? sameRole.length : matchCount(index, primary.selector);
	chain.push({ by: "path", path: element.id, role: entry.role });

	return {
		kind: "selector",
		selector,
		chain,
		...(matches > 1 && { matches }),
		landmark: {
			role: entry.role,
			frame: { ...element.frame },
			...(entry.name !== undefined && { label: entry.name }),
		},
	};
}
