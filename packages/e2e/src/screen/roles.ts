import type { Element, Role } from "../driver/driver.types";

/** The role vocabulary `getByRole` and `role=` selectors speak. */
export const QUERY_ROLES = [
	"button",
	"link",
	"textbox",
	"searchbox",
	"checkbox",
	"radio",
	"switch",
	"slider",
	"image",
	"heading",
	"text",
	"tab",
	"tablist",
	"menu",
	"menuitem",
	"list",
	"listitem",
	"row",
	"alert",
	"dialog",
	"navigation",
	"group",
	"other",
] as const;

export type QueryRole = (typeof QUERY_ROLES)[number];

const QUERY_ROLE_SET: ReadonlySet<string> = new Set(QUERY_ROLES);

export function isQueryRole(value: string): value is QueryRole {
	return QUERY_ROLE_SET.has(value);
}

const INTERACTIVE_ROLES: ReadonlySet<QueryRole> = new Set<QueryRole>([
	"button",
	"link",
	"textbox",
	"searchbox",
	"checkbox",
	"radio",
	"switch",
	"slider",
	"tab",
	"menuitem",
]);

/** Roles `snapshot -i` keeps: things a user can act on. */
export function isInteractiveRole(role: QueryRole): boolean {
	return INTERACTIVE_ROLES.has(role);
}

const DRIVER_ROLE_MAP: Record<Role, QueryRole> = {
	button: "button",
	text: "text",
	textfield: "textbox",
	securefield: "textbox",
	searchfield: "searchbox",
	image: "image",
	switch: "switch",
	checkbox: "checkbox",
	slider: "slider",
	link: "link",
	cell: "listitem",
	list: "list",
	scrollview: "group",
	tab: "tab",
	tabbar: "tablist",
	alert: "alert",
	sheet: "dialog",
	keyboard: "other",
	navbar: "navigation",
	toolbar: "group",
	window: "other",
	application: "other",
	other: "other",
};

/**
 * What React Native writes into an iOS view's accessibility value for roles UIKit has no trait for (`checkbox,
 * unchecked`, `radio button, checked`): XCTest then reports an `Other` whose value names the role.
 */
const SPELLED_ROLES: Readonly<Record<string, QueryRole>> = {
	alert: "alert",
	checkbox: "checkbox",
	"combo box": "other",
	menu: "menu",
	"menu bar": "menu",
	"menu item": "menuitem",
	"progress bar": "other",
	"radio button": "radio",
	"radio group": "group",
	"scroll bar": "other",
	"spin button": "other",
	switch: "switch",
	tab: "tab",
	"tab list": "tablist",
	timer: "other",
	"tool bar": "group",
};

const SPELLED_STATES: Readonly<Record<string, { checked?: boolean; expanded?: boolean }>> = {
	checked: { checked: true },
	unchecked: { checked: false },
	expanded: { expanded: true },
	collapsed: { expanded: false },
};

/** Words React Native may write after the role that carry no state we model; they stay in the value. */
const SPELLED_LOOSE_WORDS: ReadonlySet<string> = new Set(["mixed", "busy"]);

export type SpelledValue = { checked?: boolean; expanded?: boolean; role: QueryRole; value: string | undefined };

/** Reads `<role description>[, <state>…][, <value>]` back; undefined for any value that does not start with a role. */
export function parseSpelledValue(value: string | undefined): SpelledValue | undefined {
	if (value === undefined) return undefined;
	const parts = value.split(", ");
	const role = SPELLED_ROLES[parts[0]?.toLowerCase() ?? ""];
	if (role === undefined) return undefined;
	const states: { checked?: boolean; expanded?: boolean } = {};
	const rest: string[] = [];
	let position = 1;
	for (; position < parts.length; position += 1) {
		const part = parts[position] ?? "";
		const word = part.toLowerCase();
		const state = SPELLED_STATES[word];
		if (state !== undefined) {
			Object.assign(states, state);
			continue;
		}
		if (SPELLED_LOOSE_WORDS.has(word)) {
			rest.push(part);
			continue;
		}
		break;
	}
	rest.push(...parts.slice(position));
	return { ...states, role, value: rest.length === 0 ? undefined : rest.join(", ") };
}

/** Android view classes by kebab-cased simple name. Anything unlisted falls back to the driver role. */
const ANDROID_ROLE_MAP: Readonly<Record<string, QueryRole>> = {
	"text-view": "text",
	"edit-text": "textbox",
	"auto-complete-text-view": "textbox",
	"text-input-edit-text": "textbox",
	"search-view": "searchbox",
	button: "button",
	"image-button": "button",
	"material-button": "button",
	"image-view": "image",
	switch: "switch",
	"switch-compat": "switch",
	"switch-material": "switch",
	"toggle-button": "switch",
	"check-box": "checkbox",
	"material-check-box": "checkbox",
	"radio-button": "radio",
	"seek-bar": "slider",
	slider: "slider",
	"tab-layout": "tablist",
	"tab-widget": "tablist",
	"bottom-navigation-view": "tablist",
	"recycler-view": "list",
	"list-view": "list",
	"abs-list-view": "list",
	"grid-view": "list",
	"scroll-view": "group",
	"horizontal-scroll-view": "group",
	"view-group": "group",
	view: "group",
	"compose-view": "group",
	"view-factory-holder": "group",
	"card-view": "group",
};

/** Classes that are plain containers: only these are promoted by `clickable` / `checkable`. */
const ANDROID_GENERIC_CONTAINERS: ReadonlySet<string> = new Set([
	"view-group",
	"view",
	"compose-view",
	"view-factory-holder",
	"card-view",
]);

function kebabSimpleName(rawType: string): string {
	const simple = rawType.slice(rawType.lastIndexOf(".") + 1);
	return simple
		.replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replaceAll(/[\s_$]+/g, "-")
		.toLowerCase();
}

function isAndroidClass(rawType: string): boolean {
	return rawType.includes(".");
}

export type ResolvedRole = { role: QueryRole; spelled?: SpelledValue };

function upgradeByTraits(role: QueryRole, traits: ReadonlySet<string>): QueryRole {
	if (role !== "other" && role !== "group" && role !== "text") return role;
	if (traits.has("header") || traits.has("heading")) return "heading";
	if (role === "text" && !traits.has("link") && !traits.has("button")) return role;
	if (traits.has("link")) return "link";
	if (traits.has("button")) return "button";
	if (role === "text") return role;
	if (traits.has("image")) return "image";
	if (traits.has("adjustable")) return "slider";
	if (traits.has("searchfield")) return "searchbox";
	return role;
}

function resolveAndroid(element: Element, traits: ReadonlySet<string>): QueryRole {
	const kind = kebabSimpleName(element.rawType);
	const mapped = ANDROID_ROLE_MAP[kind];
	const isLayout = kind.endsWith("layout");
	const driverRole = DRIVER_ROLE_MAP[element.role];
	const role = mapped ?? (isLayout && driverRole === "other" ? "group" : driverRole);
	const container = role === "group" || role === "other";
	if (traits.has("heading") && (container || role === "text")) return "heading";
	const promotable = container && (mapped === undefined || isLayout || ANDROID_GENERIC_CONTAINERS.has(kind));
	if (!promotable) return role;
	if (traits.has("checkable")) return "checkbox";
	return traits.has("clickable") ? "button" : role;
}

/**
 * The query role for one driver element. `parent` lets iOS tab bar items (reported as plain buttons) answer `tab`.
 * Precedence: React Native spelled value on an `Other`, Android class, driver role, then trait upgrades.
 */
export function resolveRole(element: Element, parent?: Element): ResolvedRole {
	const traits = new Set(element.traits.map((trait) => trait.toLowerCase()));
	if (isAndroidClass(element.rawType)) return { role: resolveAndroid(element, traits) };
	if (element.role === "other") {
		const spelled = parseSpelledValue(element.value);
		if (spelled !== undefined) return { role: spelled.role, spelled };
	}
	if (element.role === "button" && parent?.role === "tabbar") return { role: "tab" };
	return { role: upgradeByTraits(DRIVER_ROLE_MAP[element.role], traits) };
}
