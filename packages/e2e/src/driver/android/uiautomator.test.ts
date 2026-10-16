import { describe, expect, test } from "bun:test";
import type { Element } from "../driver.types";
import { interactiveFilter, parseUiautomatorXml, UiautomatorParseError } from "./uiautomator";
import {
	REAL_DEV_LAUNCHER_DUMP,
	REAL_DEV_LAUNCHER_SCREEN,
	SYNTHETIC_FORM_DUMP,
	SYNTHETIC_FORM_SCREEN,
} from "./uiautomator.fixture";

function byIdentifier(flat: Element[], identifier: string): Element {
	const found = flat.find((e) => e.identifier === identifier);
	if (!found) throw new Error(`no element with identifier ${identifier}`);
	return found;
}

describe("parseUiautomatorXml (synthetic form)", () => {
	const { elements, flat } = parseUiautomatorXml(SYNTHETIC_FORM_DUMP, SYNTHETIC_FORM_SCREEN);

	test("strips the trailer and builds a tree with preorder ids and depth", () => {
		expect(elements).toHaveLength(1);
		const root = elements[0];
		expect(root?.id).toBe("0");
		expect(root?.depth).toBe(0);
		expect(root?.children[0]?.id).toBe("0.0");
		expect(root?.children[0]?.depth).toBe(1);
		expect(root?.children[0]?.children[1]?.id).toBe("0.0.1");
		expect(flat[0]).toBe(root as Element);
		expect(flat.map((e) => e.id).slice(0, 3)).toEqual(["0", "0.0", "0.0.0"]);
	});

	test("resource-id: bare testID and pkg:id/ prefix both become identifier", () => {
		expect(byIdentifier(flat, "email-input").rawType).toBe("android.widget.EditText");
		expect(byIdentifier(flat, "root").rawType).toBe("android.view.ViewGroup");
		expect(byIdentifier(flat, "notifications").role).toBe("switch");
	});

	test("text, content-desc (entities decoded), value and placeholder", () => {
		const email = byIdentifier(flat, "email-input");
		expect(email.text).toBe("a@b.co");
		expect(email.value).toBe("a@b.co");
		expect(email.placeholder).toBe("Email");
		const login = byIdentifier(flat, "login-button");
		expect(login.label).toBe('Log in & "go" <now>\nplease');
		expect(login.text).toBeUndefined();
		expect(login.value).toBeUndefined();
	});

	test("bounds -> frame, normFrame, tapPoint", () => {
		const email = byIdentifier(flat, "email-input");
		expect(email.frame).toEqual({ x: 60, y: 220, width: 960, height: 120 });
		expect(email.normFrame.x).toBeCloseTo(60 / 1080);
		expect(email.normFrame.y).toBeCloseTo(220 / 2400);
		expect(email.normFrame.width).toBeCloseTo(960 / 1080);
		expect(email.normFrame.height).toBeCloseTo(120 / 2400);
		expect(email.tapPoint).toEqual({ x: 540, y: 280 });
	});

	test("class -> role", () => {
		const roles = (id: string) => byIdentifier(flat, id).role;
		expect(roles("email-input")).toBe("textfield");
		expect(roles("password-input")).toBe("securefield");
		expect(roles("remember-me")).toBe("checkbox");
		expect(roles("notifications")).toBe("switch");
		expect(roles("volume")).toBe("slider");
		expect(roles("list")).toBe("list");
		expect(roles("login-button")).toBe("button");
		expect(roles("disabled-button")).toBe("button");
		expect(roles("offscreen-fab")).toBe("button");
		expect(roles("root")).toBe("other");
		expect(flat.find((e) => e.text === "Sign in")?.role).toBe("text");
		expect(flat.find((e) => e.label === "Logo")?.role).toBe("image");
	});

	test("flags -> traits and booleans", () => {
		const email = byIdentifier(flat, "email-input");
		expect(email.traits).toEqual(["clickable", "long-clickable", "focused"]);
		expect(email.focused).toBe(true);
		const remember = byIdentifier(flat, "remember-me");
		expect(remember.traits).toEqual(["clickable", "checkable", "checked"]);
		expect(remember.checked).toBe(true);
		expect(byIdentifier(flat, "notifications").checked).toBe(false);
		expect(byIdentifier(flat, "root").checked).toBeUndefined();
		expect(byIdentifier(flat, "list").traits).toEqual(["scrollable"]);
		expect(byIdentifier(flat, "password-input").traits).toContain("password");
		expect(byIdentifier(flat, "disabled-button").enabled).toBe(false);
	});

	test("hittable = clickable && enabled && on-screen", () => {
		expect(byIdentifier(flat, "login-button").hittable).toBe(true);
		expect(byIdentifier(flat, "disabled-button").hittable).toBe(false);
		expect(byIdentifier(flat, "offscreen-fab").hittable).toBe(false);
		expect(byIdentifier(flat, "root").hittable).toBe(false);
	});

	test("accepts the misspelled trailer some images print", () => {
		const typo = SYNTHETIC_FORM_DUMP.replace("UI hierarchy dumped to", "UI hierchary dumped to");
		expect(parseUiautomatorXml(typo, SYNTHETIC_FORM_SCREEN).flat.length).toBe(flat.length);
	});
});

describe("parseUiautomatorXml (real dev-launcher capture)", () => {
	const { elements, flat } = parseUiautomatorXml(REAL_DEV_LAUNCHER_DUMP, REAL_DEV_LAUNCHER_SCREEN);

	test("parses the whole tree", () => {
		expect(elements).toHaveLength(1);
		expect(flat.length).toBeGreaterThan(30);
		expect(flat.every((e) => e.frame.width >= 0 && e.frame.height >= 0)).toBe(true);
	});

	test("resource-id prefixes are stripped", () => {
		expect(flat.some((e) => e.identifier === "action_bar_root")).toBe(true);
		expect(flat.some((e) => e.identifier === "content")).toBe(true);
		expect(flat.some((e) => e.identifier?.includes(":id/"))).toBe(false);
	});

	test("finds the EditText, ScrollView, text and clickable Compose view", () => {
		expect(flat.some((e) => e.role === "textfield" && e.rawType === "android.widget.EditText")).toBe(true);
		expect(flat.some((e) => e.role === "scrollview")).toBe(true);
		expect(flat.find((e) => e.text === "Delacour UI")?.role).toBe("text");
		expect(flat.some((e) => e.rawType === "android.view.View" && e.role === "button" && e.hittable)).toBe(true);
		expect(flat.find((e) => e.label === "App Icon")?.role).toBe("image");
	});
});

describe("parseUiautomatorXml errors and edge cases", () => {
	const screen = { width: 100, height: 200 };

	test("throws UiautomatorParseError without a hierarchy", () => {
		expect(() => parseUiautomatorXml("ERROR: null root node returned by UiTestAutomationBridge.", screen)).toThrow(
			UiautomatorParseError
		);
		expect(() => parseUiautomatorXml("", screen)).toThrow(UiautomatorParseError);
	});

	test("empty self-closing hierarchy yields no elements", () => {
		expect(parseUiautomatorXml('<?xml version="1.0"?><hierarchy rotation="0" />', screen)).toEqual({
			elements: [],
			flat: [],
		});
	});

	test("a `>` inside an attribute value does not end the tag", () => {
		const xml =
			'<hierarchy><node text="a > b" resource-id="" class="android.widget.TextView" content-desc="" bounds="[0,0][10,10]" enabled="true" /></hierarchy>';
		expect(parseUiautomatorXml(xml, screen).flat[0]?.text).toBe("a > b");
	});

	test("numeric character references are decoded", () => {
		const xml =
			'<hierarchy><node text="&#65;&#x42;&apos;" resource-id="" class="android.widget.TextView" content-desc="" bounds="[0,0][10,10]" /></hierarchy>';
		expect(parseUiautomatorXml(xml, screen).flat[0]?.text).toBe("AB'");
	});

	test("missing or malformed bounds give a zero frame", () => {
		const xml = '<hierarchy><node class="android.widget.TextView" bounds="nope" /></hierarchy>';
		expect(parseUiautomatorXml(xml, screen).flat[0]?.frame).toEqual({ x: 0, y: 0, width: 0, height: 0 });
	});

	test("zero-size screen does not divide by zero", () => {
		const xml = '<hierarchy><node class="android.widget.TextView" bounds="[0,0][10,10]" /></hierarchy>';
		const element = parseUiautomatorXml(xml, { width: 0, height: 0 }).flat[0];
		expect(element?.normFrame).toEqual({ x: 0, y: 0, width: 0, height: 0 });
	});
});

describe("interactiveFilter", () => {
	const parsed = parseUiautomatorXml(SYNTHETIC_FORM_DUMP, SYNTHETIC_FORM_SCREEN);
	const filtered = interactiveFilter(parsed.elements);

	test("keeps interactive nodes and their ancestors only", () => {
		const ids = filtered.flat.map((e) => e.identifier ?? e.rawType.split(".").pop());
		expect(ids).toContain("email-input");
		expect(ids).toContain("password-input");
		expect(ids).toContain("remember-me");
		expect(ids).toContain("login-button");
		expect(ids).toContain("list");
		expect(ids).toContain("root");
		expect(filtered.flat.some((e) => e.text === "Sign in")).toBe(false);
		expect(filtered.flat.some((e) => e.text === "Static footer")).toBe(false);
		expect(filtered.flat.some((e) => e.label === "Logo")).toBe(false);
	});

	test("keeps long-clickable rows and the ancestors up to the root", () => {
		const row = filtered.flat.find((e) => e.traits.includes("long-clickable") && e.role === "other");
		expect(row).toBeDefined();
		expect(filtered.elements[0]?.id).toBe("0");
	});

	test("flat is the preorder of the filtered tree, ids and depth are preserved", () => {
		const walk = (list: Element[]): Element[] => list.flatMap((e) => [e, ...walk(e.children)]);
		expect(filtered.flat).toEqual(walk(filtered.elements));
		const email = filtered.flat.find((e) => e.identifier === "email-input");
		const original = parsed.flat.find((e) => e.identifier === "email-input");
		expect(email?.id).toBe(original?.id as string);
		expect(email?.depth).toBe(original?.depth as number);
	});

	test("does not mutate the input tree", () => {
		expect(parsed.flat.some((e) => e.text === "Sign in")).toBe(true);
		const root = parsed.elements[0];
		expect(root?.children[0]?.children.length).toBeGreaterThan(filtered.flat.filter((e) => e.depth === 2).length);
	});

	test("empty input", () => {
		expect(interactiveFilter([])).toEqual({ elements: [], flat: [] });
	});
});
