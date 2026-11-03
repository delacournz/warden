import type { Snapshot } from "../driver/driver.types";
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
};

export type RenderedSnapshot = {
	lines: string[];
	/** element lines printed */
	shown: number;
	/** elements in the snapshot */
	total: number;
	/** elements cut by `maxLines` */
	omitted: number;
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

/** The entries `interactiveOnly` lists: visible ones that are interactive or carry a testID. */
export function isListed(entry: NodeEntry): boolean {
	if (entry.states.hidden) return false;
	const id = entry.element.identifier;
	return isInteractiveRole(entry.role) || (id !== undefined && id !== "");
}

/** The `warden ui snapshot` body: one line per element in document order. */
export function renderSnapshot(snapshot: Snapshot, options: RenderOptions): RenderedSnapshot {
	const index = indexSnapshot(snapshot);
	const listed = options.interactiveOnly ? index.entries.filter(isListed) : index.entries;
	const limit = options.maxLines === undefined ? listed.length : Math.max(0, options.maxLines);
	const visible = listed.slice(0, limit);
	const lines = visible.map((entry) =>
		renderEntryLine(entry, {
			indent: options.interactiveOnly ? 0 : entry.depth,
			...(options.a11y ? { a11y: true } : {}),
			...(options.refs.has(entry.element.id) ? { ref: options.refs.get(entry.element.id) } : {}),
		})
	);
	const omitted = listed.length - visible.length;
	if (omitted > 0) lines.push(`… ${omitted} more (use --all)`);
	return { lines, shown: visible.length, total: index.entries.length, omitted };
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
