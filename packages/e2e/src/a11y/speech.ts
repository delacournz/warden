import type { Element, Platform, Role } from "../driver/driver.types";
import type { Announcement } from "./a11y.types";

/**
 * Speech model. APPROXIMATES, never equals, what VoiceOver (iOS) or TalkBack (Android) says:
 * word order and role/state vocabulary follow the documented behaviour of each reader, but
 * locale, verbosity settings, OS version differences and app-specific custom roles are not modelled.
 * Every result carries `source: "simulated"`.
 */

export type AnnounceOptions = {
	/** include the hint as the last part (default true) */
	hints?: boolean;
};

const ACTIONABLE_ROLES: ReadonlySet<Role> = new Set([
	"button",
	"switch",
	"checkbox",
	"slider",
	"link",
	"tab",
	"textfield",
	"securefield",
	"searchfield",
]);

const INPUT_ROLES: ReadonlySet<Role> = new Set(["textfield", "securefield", "searchfield"]);

const ON_VALUES: ReadonlySet<string> = new Set(["1", "on", "true", "checked"]);
const OFF_VALUES: ReadonlySet<string> = new Set(["0", "off", "false", "unchecked"]);

function clean(s: string | undefined): string | undefined {
	const t = s?.trim();
	return t ? t : undefined;
}

function has(el: Element, trait: string): boolean {
	return el.traits.includes(trait);
}

/** Can the user activate / edit this node? (what makes a screen reader stop on it and swallow its children) */
export function isActionable(el: Element, platform: Platform): boolean {
	if (ACTIONABLE_ROLES.has(el.role)) return true;
	if (platform === "ios") return has(el, "button") || has(el, "link") || has(el, "adjustable");
	return has(el, "clickable") || has(el, "long-clickable") || has(el, "checkable");
}

/** Screen-reader focus target: actionable, or the platform says it is focusable. */
export function isFocusTarget(el: Element, platform: Platform): boolean {
	return el.a11y?.focusable === true || isActionable(el, platform);
}

function isInput(el: Element): boolean {
	return INPUT_ROLES.has(el.role);
}

function ownName(el: Element, platform: Platform): string | undefined {
	const label = clean(el.label);
	if (label) return label;
	const text = clean(el.text);
	if (text) return text;
	if (isInput(el)) {
		return platform === "android" ? (clean(el.value) ?? clean(el.placeholder)) : undefined;
	}
	if (el.role === "switch" || el.role === "checkbox") return undefined;
	return platform === "android" ? clean(el.value) : undefined;
}

function descendantTexts(el: Element, platform: Platform, out: string[]): void {
	for (const child of el.children) {
		if (child.hidden) continue;
		if (child.a11y?.important === false && child.children.length === 0) continue;
		const name = clean(child.label) ?? clean(child.text) ?? (child.role === "text" ? clean(child.value) : undefined);
		if (name) out.push(name);
		else descendantTexts(child, platform, out);
	}
}

function hasActionableDescendant(el: Element, platform: Platform): boolean {
	return el.children.some((c) => !c.hidden && (isActionable(c, platform) || hasActionableDescendant(c, platform)));
}

/**
 * The accessible name. label || text || (Android) value/placeholder of inputs || merged descendant text
 * when the node is a focus target whose children are not themselves actionable (both readers merge them).
 */
export function accessibleName(el: Element, platform: Platform): string | undefined {
	const own = ownName(el, platform);
	if (own) return own;
	if (!isFocusTarget(el, platform) && el.role !== "text") return undefined;
	if (el.children.length === 0 || hasActionableDescendant(el, platform)) return undefined;
	const parts: string[] = [];
	descendantTexts(el, platform, parts);
	return parts.length ? parts.join(platform === "ios" ? " " : ", ") : undefined;
}

function switchState(el: Element): "on" | "off" | undefined {
	const v = clean(el.value)?.toLowerCase();
	if (v && ON_VALUES.has(v)) return "on";
	if (v && OFF_VALUES.has(v)) return "off";
	if (el.checked !== undefined) return el.checked ? "on" : "off";
	if (has(el, "checked")) return "on";
	return undefined;
}

function iosRoleWord(el: Element): string | undefined {
	if (has(el, "header")) return "heading";
	if (has(el, "adjustable") || el.role === "slider") return "adjustable";
	if (has(el, "link") || el.role === "link") return "link";
	switch (el.role) {
		case "switch":
			return "switch button";
		case "checkbox":
			return "checkbox";
		case "tab":
			return "tab";
		case "textfield":
			return "text field";
		case "securefield":
			return "secure text field";
		case "searchfield":
			return "search field";
		case "image":
			return "image";
		case "button":
			return "button";
		default:
	}
	if (has(el, "button")) return "button";
	if (has(el, "image")) return "image";
	return undefined;
}

function androidRoleWord(el: Element): string | undefined {
	if (has(el, "heading") || has(el, "header")) return "heading";
	if (has(el, "link") || el.role === "link") return "link";
	switch (el.role) {
		case "switch":
			return "switch";
		case "checkbox":
			return "checkbox";
		case "textfield":
		case "securefield":
		case "searchfield":
			return "edit box";
		case "image":
			return "image";
		case "button":
			return "button";
		case "tab":
			return "tab";
		case "slider":
			return "seek control";
		default:
	}
	if (has(el, "checkable")) return "checkbox";
	return undefined;
}

function expandedState(el: Element): "expanded" | "collapsed" | undefined {
	if (has(el, "expanded")) return "expanded";
	if (has(el, "collapsed")) return "collapsed";
	return undefined;
}

function join(parts: readonly (string | undefined)[]): string {
	return parts.filter((p): p is string => !!p).join(", ");
}

function announceIos(el: Element, opts: AnnounceOptions): Announcement {
	const label = accessibleName(el, "ios");
	const toggle = el.role === "switch" || el.role === "checkbox" ? switchState(el) : undefined;
	const rawValue = clean(el.value);
	let value: string | undefined;
	if (el.role === "securefield") value = undefined;
	else if (isInput(el)) value = rawValue ?? clean(el.placeholder);
	else if (!toggle && el.role !== "text" && rawValue && rawValue !== label) value = rawValue;
	const role = iosRoleWord(el);
	const state: string[] = [];
	if (toggle) state.push(toggle);
	if (el.selected || has(el, "selected")) state.push("selected");
	const expanded = expandedState(el);
	if (expanded) state.push(expanded);
	if (!el.enabled || has(el, "not-enabled")) state.push("dimmed");
	const hint = opts.hints === false ? undefined : clean(el.a11y?.hint);
	return build(el, "ios", { label, value, role, state, hint }, join([label, value, role, ...state, hint]));
}

function announceAndroid(el: Element, opts: AnnounceOptions): Announcement {
	const name = accessibleName(el, "android");
	const state: string[] = [];
	const toggle = switchState(el);
	if (el.role === "switch") {
		if (toggle) state.push(toggle);
	} else if (el.role === "checkbox" || has(el, "checkable")) {
		const checked = el.checked ?? has(el, "checked");
		state.push(checked ? "checked" : "not checked");
	}
	if (el.selected || has(el, "selected")) state.push("selected");
	const expanded = expandedState(el);
	if (expanded) state.push(expanded);
	const role = androidRoleWord(el);
	const disabled = !el.enabled;
	const hint = opts.hints === false ? undefined : clean(el.a11y?.hint);
	const text = join([...state, name, role, disabled ? "disabled" : undefined, hint]);
	return build(el, "android", { label: name, role, state: disabled ? [...state, "disabled"] : state, hint }, text);
}

function build(
	el: Element,
	platform: Platform,
	parts: Omit<Announcement["parts"], "state"> & { state: string[] },
	text: string
): Announcement {
	const { label, value, role, state, hint } = parts;
	return {
		id: el.id,
		...(el.identifier ? { identifier: el.identifier } : {}),
		text,
		role: el.role,
		platform,
		source: "simulated",
		parts: {
			...(label ? { label } : {}),
			...(value ? { value } : {}),
			...(role ? { role } : {}),
			state,
			...(hint ? { hint } : {}),
		},
	};
}

/**
 * What the platform's screen reader would say when focus lands on `el`. SIMULATED: an approximation of
 * VoiceOver / TalkBack from the snapshot's facts, not their real output. `source` is always `"simulated"`.
 */
export function announce(el: Element, platform: Platform, opts: AnnounceOptions = {}): Announcement {
	return platform === "ios" ? announceIos(el, opts) : announceAndroid(el, opts);
}
