import type { Element, Point, Snapshot } from "@delacour/warden-driver/driver.types";
import { type NodeEntry, type NodeIndex, nodeIndexer } from "@delacour/warden-screen/nodes";
import { type ParsedSelector, selectorEngine } from "@delacour/warden-screen/selector";
import type { ChainEntry, CoordsTarget, Target } from "./recording.schema";

/** Turn an element the user pointed at into a durable target (never an `@ref`), degrading to coordinates. */

const DEFAULT_COORDS_WARNING = "recorded by coordinates; it will not survive a layout change";

type Candidate = { by: "id" | "role-label" | "role-text"; selector: ParsedSelector };

export class TargetResolver {
	private centre(element: Element): Point {
		return (
			element.tapPoint ?? {
				x: element.frame.x + element.frame.width / 2,
				y: element.frame.y + element.frame.height / 2,
			}
		);
	}

	coordsTarget(point: Point, warning: string = DEFAULT_COORDS_WARNING): CoordsTarget {
		return { kind: "coords", x: point.x, y: point.y, warning };
	}

	private text(value: string): { kind: "text"; value: string } {
		return { kind: "text", value };
	}

	private nonEmpty(value: string | undefined): string | undefined {
		return value === undefined || value === "" ? undefined : value;
	}

	/** Nodes matching `selector` (substring terms are loose, so this can be more than the one pointed at). */
	private matchCount(index: NodeIndex, selector: ParsedSelector): number {
		return index.entries.filter((candidate) => selectorEngine.matchesSelector(candidate, selector)).length;
	}

	/** `formatSelector(selector)`, plus `nth=` when other nodes match too. */
	private pinned(index: NodeIndex, entry: NodeEntry, selector: ParsedSelector): string {
		const matches = index.entries.filter((candidate) => selectorEngine.matchesSelector(candidate, selector));
		if (matches.length === 1 && matches[0] === entry) return selectorEngine.formatSelector(selector);
		return selectorEngine.formatSelector({ ...selector, nth: Math.max(0, matches.indexOf(entry)) });
	}

	/** The selectors an element can be found by, most durable first: id, role+label, role+text (when it differs). */
	private selectorCandidates(element: Element, role: { kind: "text"; value: string }): Candidate[] {
		const candidates: Candidate[] = [];
		const identifier = this.nonEmpty(element.identifier);
		if (identifier !== undefined) candidates.push({ by: "id", selector: { id: this.text(identifier) } });
		const label = this.nonEmpty(element.label);
		if (label !== undefined) candidates.push({ by: "role-label", selector: { role, label: this.text(label) } });
		const ownText = this.nonEmpty(element.text);
		if (ownText !== undefined && ownText !== label) {
			candidates.push({ by: "role-text", selector: { role, text: this.text(ownText) } });
		}
		return candidates;
	}

	/**
	 * The resolved target for an element of `snapshot`: a selector chain (id → role+label → role+text → path) plus a landmark.
	 * Never an `@ref`. An element that is not in the snapshot degrades to a coordinate target.
	 */
	targetFromElement(element: Element, snapshot: Snapshot): Target {
		const index = nodeIndexer.indexSnapshot(snapshot);
		const entry = index.byId.get(element.id);
		if (!entry)
			return this.coordsTarget(this.centre(element), "element was not in the snapshot; recorded by coordinates");

		const role = this.text(entry.role);
		const candidates = this.selectorCandidates(element, role);
		const chain: ChainEntry[] = candidates.map(({ by, selector }) => ({
			by,
			selector: this.pinned(index, entry, selector),
		}));

		const sameRole = index.entries.filter((candidate) => candidate.role === entry.role);
		const primary = candidates[0];
		const selector =
			chain[0] && "selector" in chain[0]
				? chain[0].selector
				: selectorEngine.formatSelector({ role, nth: sameRole.indexOf(entry) });
		const matches = primary === undefined ? sameRole.length : this.matchCount(index, primary.selector);
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
}

export const targetResolver = new TargetResolver();
