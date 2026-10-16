import type { Element, Rect, ScreenInfo, Snapshot } from "../driver/driver.types";
import { type QueryRole, resolveRole, type SpelledValue } from "./roles";
import { normalizeText } from "./text";

export type NodeStates = {
	/** undefined when the node is not checkable */
	checked: boolean | undefined;
	expanded: boolean | undefined;
	disabled: boolean;
	selected: boolean;
	focused: boolean;
	/** the driver's `hidden` flag, inherited from ancestors; queries use this, `visible` adds geometry */
	hidden: boolean;
};

/** One accessibility node with everything queries need derived once per snapshot. */
export type NodeEntry = {
	/** index into `NodeIndex.entries` (document order) */
	position: number;
	element: Element;
	depth: number;
	parent: NodeEntry | undefined;
	children: NodeEntry[];
	role: QueryRole;
	/** accessible name: label, else text */
	name: string | undefined;
	/** displayed value with React Native role prefixes removed; never set for secure fields */
	value: string | undefined;
	states: NodeStates;
	secure: boolean;
	/** not hidden, non-empty frame, intersecting the screen */
	visible: boolean;
	/** normalised label/text/value of this node and its descendants, echoes removed, in document order */
	fragments: string[];
	/** `fragments` joined with a space */
	subtreeText: string;
};

export type NodeIndex = {
	entries: readonly NodeEntry[];
	byId: ReadonlyMap<string, NodeEntry>;
	screen: ScreenInfo;
};

const CHECKABLE_ROLES: ReadonlySet<QueryRole> = new Set<QueryRole>(["switch", "checkbox", "radio"]);
const CHECKED_WORDS: ReadonlySet<string> = new Set(["1", "on", "true", "checked"]);
const UNCHECKED_WORDS: ReadonlySet<string> = new Set(["0", "off", "false", "unchecked"]);

function nonEmpty(value: string | undefined): string | undefined {
	return value === undefined || value === "" ? undefined : value;
}

function isSecure(element: Element, traits: ReadonlySet<string>): boolean {
	return (
		element.role === "securefield" ||
		traits.has("password") ||
		traits.has("secure") ||
		element.rawType.toLowerCase().includes("secure")
	);
}

function deriveChecked(
	element: Element,
	role: QueryRole,
	spelled: SpelledValue | undefined,
	traits: ReadonlySet<string>,
	value: string | undefined
): boolean | undefined {
	if (spelled?.checked !== undefined) return spelled.checked;
	if (element.checked !== undefined) return element.checked;
	if (traits.has("checkable")) return traits.has("checked");
	if (CHECKABLE_ROLES.has(role) && value !== undefined) {
		const word = value.trim().toLowerCase();
		if (CHECKED_WORDS.has(word)) return true;
		if (UNCHECKED_WORDS.has(word)) return false;
	}
	return undefined;
}

function intersectsScreen(frame: Rect, screen: ScreenInfo): boolean {
	if (frame.width <= 0 || frame.height <= 0) return false;
	if (screen.width <= 0 || screen.height <= 0) return true;
	return frame.x < screen.width && frame.y < screen.height && frame.x + frame.width > 0 && frame.y + frame.height > 0;
}

function ownFragments(name: string | undefined, element: Element, value: string | undefined): string[] {
	const seen = new Set<string>();
	for (const raw of [element.label, element.text, value]) {
		const text = raw === undefined ? "" : normalizeText(raw);
		if (text !== "") seen.add(text);
	}
	if (name !== undefined && normalizeText(name) !== "") seen.add(normalizeText(name));
	return [...seen];
}

/** Flattens a snapshot into document-order entries with parent/child links and derived state. */
export function indexSnapshot(snapshot: Snapshot): NodeIndex {
	const entries: NodeEntry[] = [];
	const byId = new Map<string, NodeEntry>();

	const build = (element: Element, depth: number, parent: NodeEntry | undefined): NodeEntry => {
		const traits = new Set(element.traits.map((trait) => trait.toLowerCase()));
		const { role, spelled } = resolveRole(element, parent?.element);
		const secure = isSecure(element, traits);
		const rawValue = spelled === undefined ? element.value : spelled.value;
		const value = secure ? undefined : nonEmpty(rawValue);
		const name = nonEmpty(element.label) ?? nonEmpty(element.text);
		const hidden = element.hidden === true || parent?.states.hidden === true;
		const entry: NodeEntry = {
			position: entries.length,
			element,
			depth,
			parent,
			children: [],
			role,
			name,
			value,
			states: {
				checked: deriveChecked(element, role, spelled, traits, value),
				expanded: spelled?.expanded,
				disabled: !element.enabled,
				selected: element.selected === true,
				focused: element.focused === true,
				hidden,
			},
			secure,
			visible: !hidden && intersectsScreen(element.frame, snapshot.screen),
			fragments: [],
			subtreeText: "",
		};
		entries.push(entry);
		byId.set(element.id, entry);
		for (const child of element.children) entry.children.push(build(child, depth + 1, entry));

		const below = entry.children.flatMap((child) => child.fragments);
		const belowText = below.join(" ");
		const own = ownFragments(name, element, value).filter((text) => text !== belowText && !below.includes(text));
		entry.fragments = [...own, ...below];
		entry.subtreeText = entry.fragments.join(" ");
		return entry;
	};

	for (const element of snapshot.elements) build(element, 0, undefined);
	return { entries, byId, screen: snapshot.screen };
}

/** True when `entry` is a strict descendant of `ancestor`. */
export function isWithin(entry: NodeEntry, ancestor: NodeEntry): boolean {
	for (let current = entry.parent; current !== undefined; current = current.parent) {
		if (current === ancestor) return true;
	}
	return false;
}

/** Strict descendants of any of `ancestors` among `universe`, in the universe's order. */
export function descendantsOf(universe: readonly NodeEntry[], ancestors: readonly NodeEntry[]): NodeEntry[] {
	if (ancestors.length === 0) return [];
	const wanted = new Set(ancestors);
	return universe.filter((entry) => {
		for (let current = entry.parent; current !== undefined; current = current.parent) {
			if (wanted.has(current)) return true;
		}
		return false;
	});
}

/** The snapshot entry of one element (its role, name, value and secure flag), for rules that need more than the `Element`. */
export function entryOfElement(element: Element, template: Pick<Snapshot, "platform">): NodeEntry | undefined {
	const flat: Element[] = [];
	const walk = (e: Element): void => {
		flat.push(e);
		for (const child of e.children) walk(child);
	};
	walk(element);
	const index = indexSnapshot({
		platform: template.platform,
		backend: "axbridge",
		takenAt: 0,
		screen: { width: 0, height: 0, scale: 1 },
		elements: [element],
		flat,
		truncated: false,
	});
	return index.entries[0];
}
