import type { Element, Rect, Role } from "../driver.types";
import type { UiadNode } from "./uiad-protocol";

/** Thrown when the text has no `<hierarchy>` (e.g. `ERROR: null root node returned by UiTestAutomationBridge.`). */
export class UiautomatorParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UiautomatorParseError";
	}
}

export type ParsedTree = { elements: Element[]; flat: Element[] };

type RawNode = { attrs: Map<string, string>; children: RawNode[] };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(value: string): string {
	if (!value.includes("&")) return value;
	return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
		if (body.startsWith("#x")) return safeCodePoint(Number.parseInt(body.slice(2), 16), whole);
		if (body.startsWith("#")) return safeCodePoint(Number.parseInt(body.slice(1), 10), whole);
		return ENTITIES[body] ?? whole;
	});
}

function safeCodePoint(code: number, fallback: string): string {
	return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

type Token =
	| { kind: "open"; name: string; attrs: Map<string, string>; selfClosing: boolean }
	| { kind: "close"; name: string };

const isSpace = (ch: string): boolean => /\s/.test(ch);

/** Index just past a `<?…?>` / `<!--…-->` section starting at `lt`, -1 if unterminated, undefined if not one. */
function skipMarkup(xml: string, lt: number): number | undefined {
	if (xml.startsWith("<?", lt)) {
		const end = xml.indexOf("?>", lt + 2);
		return end < 0 ? -1 : end + 2;
	}
	if (xml.startsWith("<!--", lt)) {
		const end = xml.indexOf("-->", lt + 4);
		return end < 0 ? -1 : end + 3;
	}
	return undefined;
}

type Attribute = { key: string; value: string; end: number };

/** One `key="value"` (quote-aware, so a raw `>` inside the value is fine); bare keys get "". */
function readAttribute(xml: string, from: number): Attribute | undefined {
	let p = from;
	while (p < xml.length && !/[\s=/>]/.test(xml.charAt(p))) p++;
	const key = xml.slice(from, p);
	while (p < xml.length && isSpace(xml.charAt(p))) p++;
	if (xml.charAt(p) !== "=") return { key, value: "", end: p };
	p++;
	while (p < xml.length && isSpace(xml.charAt(p))) p++;
	const quote = xml.charAt(p);
	if (quote !== '"' && quote !== "'") return { key, value: "", end: p };
	const valueEnd = xml.indexOf(quote, p + 1);
	if (valueEnd < 0) return undefined;
	return { key, value: decodeEntities(xml.slice(p + 1, valueEnd)), end: valueEnd + 1 };
}

type OpenTag = { name: string; attrs: Map<string, string>; selfClosing: boolean; end: number };

/** Parse an opening tag whose `<` is at `lt`; undefined when the text ends inside it. */
function readOpenTag(xml: string, lt: number): OpenTag | undefined {
	let p = lt + 1;
	while (p < xml.length && !/[\s/>]/.test(xml.charAt(p))) p++;
	const name = xml.slice(lt + 1, p);
	const attrs = new Map<string, string>();
	let selfClosing = false;
	while (p < xml.length) {
		const ch = xml.charAt(p);
		if (ch === ">") return { name, attrs, selfClosing, end: p + 1 };
		if (ch === "/") {
			selfClosing = true;
			p++;
		} else if (isSpace(ch)) {
			p++;
		} else {
			const attribute = readAttribute(xml, p);
			if (!attribute) return undefined;
			attrs.set(attribute.key, attribute.value);
			p = attribute.end;
		}
	}
	return undefined;
}

/** Tokenize the tags of an XML document: declarations, comments and text are skipped. */
function* tokenize(xml: string): Generator<Token> {
	let i = 0;
	while (i < xml.length) {
		const lt = xml.indexOf("<", i);
		if (lt < 0) return;
		const skipped = skipMarkup(xml, lt);
		if (skipped !== undefined) {
			if (skipped < 0) return;
			i = skipped;
			continue;
		}
		if (xml.startsWith("</", lt)) {
			const end = xml.indexOf(">", lt + 2);
			if (end < 0) return;
			yield { kind: "close", name: xml.slice(lt + 2, end).trim() };
			i = end + 1;
			continue;
		}
		const tag = readOpenTag(xml, lt);
		if (!tag) return;
		yield { kind: "open", name: tag.name, attrs: tag.attrs, selfClosing: tag.selfClosing };
		i = tag.end;
	}
}

/** Build the `<node>` forest under `<hierarchy>`; undefined when there is no `<hierarchy>` tag. */
function parseForest(xml: string): RawNode[] | undefined {
	const roots: RawNode[] = [];
	const stack: RawNode[] = [];
	let sawHierarchy = false;
	const open = (attrs: Map<string, string>, selfClosing: boolean): void => {
		const node: RawNode = { attrs, children: [] };
		(stack[stack.length - 1]?.children ?? roots).push(node);
		if (!selfClosing) stack.push(node);
	};
	for (const token of tokenize(xml)) {
		if (token.name === "hierarchy") sawHierarchy = true;
		else if (token.name !== "node") continue;
		else if (token.kind === "close") stack.pop();
		else if (sawHierarchy) open(token.attrs, token.selfClosing);
	}
	return sawHierarchy ? roots : undefined;
}

const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

function parseBounds(value: string | undefined): Rect {
	const m = BOUNDS.exec(value ?? "");
	if (!m) return { x: 0, y: 0, width: 0, height: 0 };
	const [l, t, r, b] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
	return { x: l, y: t, width: Math.max(0, r - l), height: Math.max(0, b - t) };
}

function simpleName(cls: string): string {
	return cls.slice(cls.lastIndexOf(".") + 1);
}

/** Simple-class-name suffix to role, first match wins (so `ToggleButton` beats `Button`). */
const ROLE_SUFFIXES: ReadonlyArray<readonly [string, Role]> = [
	["ToggleButton", "switch"],
	["CheckBox", "checkbox"],
	["RadioButton", "checkbox"],
	["SeekBar", "slider"],
	["Button", "button"],
	["TextView", "text"],
	["ImageView", "image"],
	["RecyclerView", "list"],
	["ListView", "list"],
	["ScrollView", "scrollview"],
];

const CLICKABLE_CONTAINERS: ReadonlySet<string> = new Set(["ViewGroup", "FrameLayout", "View"]);

/** Android `class` (+ flags) to a normalized role. Suffix matching covers `Material*`, `AppCompat*`, `React*` subclasses. */
function roleFor(cls: string, flags: { clickable: boolean; password: boolean }): Role {
	const name = simpleName(cls);
	if (name.includes("Switch")) return "switch";
	if (name.endsWith("EditText")) return flags.password ? "securefield" : "textfield";
	const bySuffix = ROLE_SUFFIXES.find(([suffix]) => name.endsWith(suffix));
	if (bySuffix) return bySuffix[1];
	return flags.clickable && CLICKABLE_CONTAINERS.has(name) ? "button" : "other";
}

function overlapsScreen(frame: Rect, screen: { width: number; height: number }): boolean {
	return (
		frame.width > 0 &&
		frame.height > 0 &&
		frame.x < screen.width &&
		frame.y < screen.height &&
		frame.x + frame.width > 0 &&
		frame.y + frame.height > 0
	);
}

type Flags = {
	clickable: boolean;
	longClickable: boolean;
	checkable: boolean;
	checked: boolean;
	scrollable: boolean;
	selected: boolean;
	focused: boolean;
	password: boolean;
	enabled: boolean;
};

function readFlags(attrs: Map<string, string>): Flags {
	const flag = (name: string): boolean => attrs.get(name) === "true";
	return {
		clickable: flag("clickable"),
		longClickable: flag("long-clickable"),
		checkable: flag("checkable"),
		checked: flag("checked"),
		scrollable: flag("scrollable"),
		selected: flag("selected"),
		focused: flag("focused"),
		password: flag("password"),
		enabled: attrs.get("enabled") !== "false",
	};
}

/** Trait names for the flags that are set, in a stable order. */
function traitsOf(f: Flags): string[] {
	const named: ReadonlyArray<readonly [boolean, string]> = [
		[f.clickable, "clickable"],
		[f.longClickable, "long-clickable"],
		[f.checkable, "checkable"],
		[f.checked, "checked"],
		[f.focused, "focused"],
		[f.scrollable, "scrollable"],
		[f.selected, "selected"],
		[f.password, "password"],
	];
	return named.filter(([on]) => on).map(([, name]) => name);
}

function normalize(frame: Rect, screen: { width: number; height: number }): Rect {
	if (screen.width <= 0 || screen.height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
	return {
		x: frame.x / screen.width,
		y: frame.y / screen.height,
		width: frame.width / screen.width,
		height: frame.height / screen.height,
	};
}

function toElement(raw: RawNode, id: string, depth: number, screen: { width: number; height: number }): Element {
	const a = raw.attrs;
	const f = readFlags(a);
	const cls = a.get("class") ?? "";
	const role = roleFor(cls, f);
	const frame = parseBounds(a.get("bounds"));
	const identifier = (a.get("resource-id") ?? "").replace(/^[^:/]+:id\//, "");
	const label = a.get("content-desc") ?? "";
	const text = a.get("text") ?? "";
	const hint = a.get("hint") ?? "";
	const isInput = role === "textfield" || role === "securefield";
	return {
		id,
		role,
		rawType: cls,
		...(label ? { label } : {}),
		...(identifier ? { identifier } : {}),
		...(isInput ? { value: text } : {}),
		...(text ? { text } : {}),
		...(hint ? { placeholder: hint } : {}),
		frame,
		normFrame: normalize(frame, screen),
		traits: traitsOf(f),
		enabled: f.enabled,
		focused: f.focused,
		selected: f.selected,
		...(f.checkable ? { checked: f.checked } : {}),
		hittable: f.clickable && f.enabled && overlapsScreen(frame, screen),
		tapPoint: { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) },
		depth,
		children: [],
	};
}

function flatten(elements: readonly Element[], out: Element[] = []): Element[] {
	for (const element of elements) {
		out.push(element);
		flatten(element.children, out);
	}
	return out;
}

/**
 * Parse `uiautomator dump` output into the normalized tree. Ids are preorder paths (`0`, `0.3`, `0.3.1`).
 * Anything outside `<hierarchy>…</hierarchy>` (the `UI hierarchy dumped to:` trailer, which some images
 * misspell `hierchary`) is ignored. Throws `UiautomatorParseError` when there is no hierarchy at all.
 */
export function parseUiautomatorXml(xml: string, screen: { width: number; height: number }): ParsedTree {
	const start = xml.indexOf("<hierarchy");
	if (start < 0) throw new UiautomatorParseError(`no <hierarchy> in uiautomator output: ${xml.slice(0, 120)}`);
	const end = xml.lastIndexOf("</hierarchy>");
	const body = end >= 0 ? xml.slice(start, end + "</hierarchy>".length) : xml.slice(start);
	const forest = parseForest(body);
	if (!forest) throw new UiautomatorParseError("unparseable uiautomator output");
	return buildTree(forest, screen);
}

/** The normalized tree of a node forest: preorder-path ids, roles, frames, traits. The one place that builds `Element`s. */
function buildTree(forest: readonly RawNode[], screen: { width: number; height: number }): ParsedTree {
	const build = (raw: RawNode, id: string, depth: number): Element => {
		const element = toElement(raw, id, depth, screen);
		element.children = raw.children.map((child, i) => build(child, `${id}.${i}`, depth + 1));
		return element;
	};
	const elements = forest.map((raw, i) => build(raw, String(i), 0));
	return { elements, flat: flatten(elements) };
}

/** A `UiadNode` as the attribute map a `<node>` of the dump would have had, so both sources share {@link toElement}. */
function rawFromUiad(node: UiadNode): RawNode {
	const [l, t, r, b] = node.bounds;
	const attrs = new Map<string, string>();
	const text = (key: string, value: string | undefined): void => {
		if (value !== undefined) attrs.set(key, value);
	};
	const flag = (key: string, on: boolean | undefined): void => {
		if (on) attrs.set(key, "true");
	};
	text("class", node.class);
	text("resource-id", node.id);
	text("text", node.text);
	text("content-desc", node.desc);
	text("hint", node.hint);
	attrs.set("bounds", `[${l},${t}][${r},${b}]`);
	flag("clickable", node.clickable);
	flag("long-clickable", node.longClickable);
	flag("checkable", node.checkable);
	flag("checked", node.checked);
	flag("scrollable", node.scrollable);
	flag("selected", node.selected);
	flag("focused", node.focused);
	flag("password", node.password);
	if (node.disabled) attrs.set("enabled", "false");
	return { attrs, children: (node.children ?? []).map(rawFromUiad) };
}

/**
 * The normalized tree of a `warden-uiad` snapshot: the same `Element`s, ids and depths `parseUiautomatorXml` gives for
 * the same screen (the server writes the dump's attributes and skips the same invisible nodes), without the XML.
 */
export function parseUiadNodes(nodes: readonly UiadNode[], screen: { width: number; height: number }): ParsedTree {
	return buildTree(nodes.map(rawFromUiad), screen);
}

function isInteractive(element: Element): boolean {
	return (
		element.traits.includes("clickable") ||
		element.traits.includes("long-clickable") ||
		element.traits.includes("checkable") ||
		element.traits.includes("scrollable") ||
		simpleName(element.rawType).endsWith("EditText")
	);
}

/**
 * Keep clickable / long-clickable / checkable / scrollable / EditText nodes plus all their ancestors.
 * Returns a new tree (inputs untouched) with ids and depths preserved; descendants of a kept node are
 * only retained when they are interactive themselves.
 */
export function interactiveFilter(elements: readonly Element[]): ParsedTree {
	const prune = (element: Element): Element | undefined => {
		const children = element.children.flatMap((child) => prune(child) ?? []);
		if (!isInteractive(element) && children.length === 0) return undefined;
		return { ...element, children };
	};
	const kept = elements.flatMap((element) => prune(element) ?? []);
	return { elements: kept, flat: flatten(kept) };
}
