import type { Rect, Snapshot } from "../driver/driver.types";
import { indexSnapshot, type NodeEntry } from "./nodes";
import { isInteractiveRole } from "./roles";

const MAX_NAME = 80;
const MAX_VALUE = 60;

export type RenderOptions = {
	/** keep interactive roles plus any element with an identifier; hidden elements are dropped, no indentation */
	interactiveOnly: boolean;
	/** element id -> `@eN`; elements without an entry print without a ref */
	refs: ReadonlyMap<string, string>;
	/** cap on element lines; a `… N more (use --all)` line follows when cut */
	maxLines?: number;
	/** append the screen-reader facts of `Element.a11y` (see {@link a11yWords}) to each line */
	a11y?: boolean;
	/** with `interactiveOnly`: list the on-screen keyboard's keys instead of folding them into one `[keyboard]` line */
	keys?: boolean;
};

/** The on-screen keyboard `interactiveOnly` folds into one line (see {@link renderKeyboardLine}). */
export type KeyboardFold = {
	/** the keyboard's host element (`role: keyboard`) */
	keyboard: NodeEntry;
	/** the return key (`go`, `next`, `search`, `done`, …), when the keyboard shows one */
	returnKey: NodeEntry | undefined;
	/** interactive elements inside the keyboard the fold leaves out */
	keys: number;
};

export type RenderedSnapshot = {
	lines: string[];
	/** element lines printed */
	shown: number;
	/** elements in the snapshot */
	total: number;
	/** elements cut by `maxLines` */
	omitted: number;
	/** the entry behind each element line, in order (`lines[i]` renders `entries[i]`; the fold's entry is its keyboard) */
	entries: NodeEntry[];
	/** set when a keyboard was folded */
	keyboard?: KeyboardFold;
};

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function quote(text: string, max: number): string {
	return JSON.stringify(truncate(text, max));
}

function identifierToken(id: string): string {
	return /^[^\s"]+$/.test(id) ? id : JSON.stringify(id);
}

function stateWords(entry: NodeEntry): string[] {
	const { states, element } = entry;
	const words = [states.disabled ? "disabled" : "enabled"];
	if (element.hittable === true) words.push("hittable");
	if (states.checked !== undefined) words.push(states.checked ? "checked" : "unchecked");
	if (states.selected) words.push("selected");
	if (states.focused) words.push("focused");
	if (entry.secure) words.push("secure");
	if (states.hidden) words.push("hidden");
	if (states.expanded !== undefined) words.push(states.expanded ? "expanded" : "collapsed");
	return words;
}

function head(entry: NodeEntry): string[] {
	const parts = [`[${entry.role}]`];
	if (entry.name !== undefined) parts.push(quote(entry.name, MAX_NAME));
	const id = entry.element.identifier;
	if (id !== undefined && id !== "") parts.push(`id=${identifierToken(id)}`);
	return parts;
}

/** `[button] "Sign in" id=sign-in-submit`: enough to tell matches apart in an error message. */
export function describeEntry(entry: NodeEntry): string {
	return head(entry).join(" ");
}

/**
 * The `--a11y` tail of an entry line: `hint="…"`, `actions=["…"]`, `a11y-focused`, `not-important`, `live=polite|assertive`.
 * Only facts the backend read are printed; an element without `a11y` adds nothing.
 */
export function a11yWords(entry: NodeEntry): string[] {
	const a11y = entry.element.a11y;
	if (!a11y) return [];
	const words: string[] = [];
	if (a11y.hint) words.push(`hint=${quote(a11y.hint, MAX_NAME)}`);
	if (a11y.actions && a11y.actions.length > 0) {
		words.push(`actions=[${a11y.actions.map((action) => quote(action, MAX_VALUE)).join(",")}]`);
	}
	if (a11y.a11yFocused) words.push("a11y-focused");
	if (a11y.important === false) words.push("not-important");
	if (a11y.liveRegion) words.push(`live=${a11y.liveRegion}`);
	return words;
}

/** `@e3 [button] "Sign in" id=sign-in-submit value="…" enabled hittable (24,332 345×48)`; `indent` is in levels. */
export function renderEntryLine(
	entry: NodeEntry,
	options: { ref?: string; indent?: number; a11y?: boolean } = {}
): string {
	const parts: string[] = [];
	if (options.ref !== undefined) parts.push(options.ref);
	parts.push(...head(entry));
	if (entry.value !== undefined) parts.push(`value=${quote(entry.value, MAX_VALUE)}`);
	parts.push(...stateWords(entry));
	const { x, y, width, height } = entry.element.frame;
	parts.push(`(${Math.round(x)},${Math.round(y)} ${Math.round(width)}×${Math.round(height)})`);
	if (options.a11y) parts.push(...a11yWords(entry));
	return `${"  ".repeat(options.indent ?? 0)}${parts.join(" ")}`;
}

/** No area, not hittable and no testID: nothing a tap can reach or a selector names (iOS keyboard `Padding-*` keys). */
function isVoid(entry: NodeEntry): boolean {
	const { frame, hittable, identifier } = entry.element;
	return (
		(frame.width <= 0 || frame.height <= 0) && hittable !== true && (identifier === undefined || identifier === "")
	);
}

/** The entries `interactiveOnly` lists: visible ones that are interactive or carry a testID, minus zero-area husks. */
export function isListed(entry: NodeEntry): boolean {
	if (entry.states.hidden || isVoid(entry)) return false;
	const id = entry.element.identifier;
	return isInteractiveRole(entry.role) || (id !== undefined && id !== "");
}

/** What the system return key is called (its identifier: `Go`, `Next`, `Return`, …), lower-cased. */
const RETURN_KEY_IDS: ReadonlySet<string> = new Set([
	"return",
	"go",
	"google",
	"join",
	"next",
	"route",
	"search",
	"send",
	"yahoo",
	"done",
	"continue",
	"emergency call",
]);

function isReturnKey(entry: NodeEntry): boolean {
	const id = entry.element.identifier?.toLowerCase();
	return entry.role === "button" && id !== undefined && RETURN_KEY_IDS.has(id);
}

function isKeyboard(entry: NodeEntry): boolean {
	return entry.element.role === "keyboard" && !entry.states.hidden;
}

/**
 * Identifiers only the system keyboard carries (its key layout and suggestion bar). Key names (`shift`, `Go`, `delete`)
 * are not markers: an app's own testIDs use the same words.
 */
const KEYBOARD_MARKER_IDS: ReadonlySet<string> = new Set(["UIKeyboardLayoutStar Preview", "SystemInputAssistantView"]);

function marksKeyboard(entry: NodeEntry): boolean {
	const id = entry.element.identifier;
	return isKeyboard(entry) || (id !== undefined && KEYBOARD_MARKER_IDS.has(id));
}

/** Points two frames may differ by and still be the keyboard's (the bridge rounds sub-point heights). */
const FRAME_SLACK = 2;

function sameFrame(a: Rect, b: Rect): boolean {
	return (
		Math.abs(a.x - b.x) <= FRAME_SLACK &&
		Math.abs(a.y - b.y) <= FRAME_SLACK &&
		Math.abs(a.width - b.width) <= FRAME_SLACK &&
		Math.abs(a.height - b.height) <= FRAME_SLACK
	);
}

function subtreeOf(entry: NodeEntry, into: Set<NodeEntry>): void {
	into.add(entry);
	for (const child of entry.children) subtreeOf(child, into);
}

function someInSubtree(entry: NodeEntry, test: (entry: NodeEntry) => boolean): boolean {
	return test(entry) || entry.children.some((child) => someInSubtree(child, test));
}

/**
 * Everything that belongs to the keyboard: the `role: keyboard` element's subtree, and every subtree at the keyboard's
 * frame that holds a keyboard marker. iOS puts an empty `inputView` placeholder in the app's window and the keys in the
 * keyboard's own window, under a container of the same frame; app views behind the keyboard are left alone.
 */
function keyboardEntries(entries: readonly NodeEntry[], keyboard: NodeEntry): Set<NodeEntry> {
	const folded = new Set<NodeEntry>();
	subtreeOf(keyboard, folded);
	const frame = keyboard.element.frame;
	for (const entry of entries) {
		if (folded.has(entry) || !sameFrame(entry.element.frame, frame)) continue;
		if (someInSubtree(entry, marksKeyboard)) subtreeOf(entry, folded);
	}
	return folded;
}

/**
 * `@e104 [keyboard] return="go" visible (0,573 402×301) 38 keys (--keys)`: the ref is the return key's (pressing it
 * presses return), the frame is the keyboard's. No return key: no ref, since a tap on the keyboard lands on a key.
 */
export function renderKeyboardLine(fold: KeyboardFold, ref?: string): string {
	const parts: string[] = [];
	if (ref !== undefined) parts.push(ref);
	parts.push("[keyboard]");
	const name = fold.returnKey?.name;
	if (name !== undefined) parts.push(`return=${quote(name, MAX_NAME)}`);
	parts.push(fold.keyboard.visible ? "visible" : "offscreen");
	const { x, y, width, height } = fold.keyboard.element.frame;
	parts.push(`(${Math.round(x)},${Math.round(y)} ${Math.round(width)}×${Math.round(height)})`);
	parts.push(`${fold.keys} ${fold.keys === 1 ? "key" : "keys"} (--keys)`);
	return parts.join(" ");
}

type Listing = { entries: NodeEntry[]; fold: KeyboardFold | undefined };

/**
 * The entries a snapshot lists, in document order. `interactiveOnly` (without `keys`) folds the keyboard (the visible
 * one, else the first): its `role: keyboard` entry stays, rendered as one `[keyboard]` line, the rest of
 * {@link keyboardEntries} goes.
 */
function listEntries(entries: readonly NodeEntry[], options: RenderOptions): Listing {
	if (!options.interactiveOnly) return { entries: [...entries], fold: undefined };
	const keyboard =
		options.keys === true
			? undefined
			: (entries.find((entry) => isKeyboard(entry) && entry.visible) ?? entries.find(isKeyboard));
	if (keyboard === undefined) return { entries: entries.filter(isListed), fold: undefined };
	const folded = keyboardEntries(entries, keyboard);
	const fold: KeyboardFold = { keyboard, returnKey: undefined, keys: 0 };
	const listed: NodeEntry[] = [];
	for (const entry of entries) {
		if (entry === keyboard) listed.push(entry);
		else if (folded.has(entry)) countKey(fold, entry);
		else if (isListed(entry)) listed.push(entry);
	}
	return { entries: listed, fold };
}

/** An entry inside the folded keyboard: counted when `-i` would have listed it as a key; the first return key is kept. */
function countKey(fold: KeyboardFold, entry: NodeEntry): void {
	if (!isListed(entry) || !isInteractiveRole(entry.role)) return;
	fold.keys += 1;
	if (fold.returnKey === undefined && isReturnKey(entry)) fold.returnKey = entry;
}

/** The `warden ui snapshot` body: one line per element in document order. */
export function renderSnapshot(snapshot: Snapshot, options: RenderOptions): RenderedSnapshot {
	const index = indexSnapshot(snapshot);
	const { entries: listed, fold } = listEntries(index.entries, options);
	const limit = options.maxLines === undefined ? listed.length : Math.max(0, options.maxLines);
	const visible = listed.slice(0, limit);
	const lines = visible.map((entry) => {
		if (fold !== undefined && entry === fold.keyboard) {
			const ref = fold.returnKey === undefined ? undefined : options.refs.get(fold.returnKey.element.id);
			return renderKeyboardLine(fold, ref);
		}
		return renderEntryLine(entry, {
			indent: options.interactiveOnly ? 0 : entry.depth,
			...(options.a11y ? { a11y: true } : {}),
			...(options.refs.has(entry.element.id) ? { ref: options.refs.get(entry.element.id) } : {}),
		});
	});
	const omitted = listed.length - visible.length;
	if (omitted > 0) lines.push(`… ${omitted} more (use --all)`);
	return {
		lines,
		shown: visible.length,
		total: index.entries.length,
		omitted,
		entries: visible,
		...(fold !== undefined ? { keyboard: fold } : {}),
	};
}

/**
 * `# ios axbridge 390×844@3x gen 12 · 5 of 8 elements (interactive)` for spec failure artifacts; with `style: "cli"`
 * the `warden ui snapshot` line, `generation 4 · axbridge · 393×852@3x · 5 of 41 elements` (`, truncated` at the end,
 * the count is `41 elements` when nothing was cut).
 */
export function renderHeader(input: {
	snapshot: Snapshot;
	rendered: RenderedSnapshot;
	interactiveOnly: boolean;
	generation?: number;
	style?: "spec" | "cli";
}): string {
	const { snapshot, rendered } = input;
	const { width, height, scale } = snapshot.screen;
	if (input.style === "cli") {
		const count = rendered.shown === rendered.total ? `${rendered.total}` : `${rendered.shown} of ${rendered.total}`;
		const parts = [
			...(input.generation === undefined ? [] : [`generation ${input.generation}`]),
			snapshot.backend,
			`${width}×${height}@${scale}x`,
			`${count} elements`,
		];
		return parts.join(" · ") + (snapshot.truncated ? ", truncated" : "");
	}
	const parts = [`# ${snapshot.platform} ${snapshot.backend} ${width}×${height}@${scale}x`];
	if (input.generation !== undefined) parts.push(`gen ${input.generation}`);
	let line = parts.join(" ");
	line += ` · ${rendered.shown} of ${rendered.total} elements (${input.interactiveOnly ? "interactive" : "all"})`;
	if (snapshot.truncated) line += " · truncated by backend";
	if (snapshot.modal !== undefined) line += " · modal present";
	return line;
}
