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

/** `@e3 [button] "Sign in" id=sign-in-submit value="…" enabled hittable (24,332 345×48)`; `indent` is in levels. */
export function renderEntryLine(entry: NodeEntry, options: { ref?: string; indent?: number } = {}): string {
	const parts: string[] = [];
	if (options.ref !== undefined) parts.push(options.ref);
	parts.push(...head(entry));
	if (entry.value !== undefined) parts.push(`value=${quote(entry.value, MAX_VALUE)}`);
	parts.push(...stateWords(entry));
	const { x, y, width, height } = entry.element.frame;
	parts.push(`(${Math.round(x)},${Math.round(y)} ${Math.round(width)}×${Math.round(height)})`);
	return `${"  ".repeat(options.indent ?? 0)}${parts.join(" ")}`;
}

function isListed(entry: NodeEntry): boolean {
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
			...(options.refs.has(entry.element.id) ? { ref: options.refs.get(entry.element.id) } : {}),
		})
	);
	const omitted = listed.length - visible.length;
	if (omitted > 0) lines.push(`… ${omitted} more (use --all)`);
	return { lines, shown: visible.length, total: index.entries.length, omitted };
}

/** `# ios axbridge 390×844@3x gen 12 · 5 of 8 elements (interactive)` */
export function renderHeader(input: {
	snapshot: Snapshot;
	rendered: RenderedSnapshot;
	interactiveOnly: boolean;
	generation?: number;
}): string {
	const { snapshot, rendered } = input;
	const { width, height, scale } = snapshot.screen;
	const parts = [`# ${snapshot.platform} ${snapshot.backend} ${width}×${height}@${scale}x`];
	if (input.generation !== undefined) parts.push(`gen ${input.generation}`);
	let line = parts.join(" ");
	line += ` · ${rendered.shown} of ${rendered.total} elements (${input.interactiveOnly ? "interactive" : "all"})`;
	if (snapshot.truncated) line += " · truncated by backend";
	if (snapshot.modal !== undefined) line += " · modal present";
	return line;
}
