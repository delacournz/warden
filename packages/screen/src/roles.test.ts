import { describe, expect, test } from "bun:test";
import { elementFixtures } from "./element.testing";
import { QUERY_ROLES, type QueryRole, roleResolver } from "./roles";

describe("resolveRole: driver roles", () => {
	const cases: [Parameters<typeof elementFixtures.el>[0], QueryRole][] = [
		["button", "button"],
		["text", "text"],
		["textfield", "textbox"],
		["securefield", "textbox"],
		["searchfield", "searchbox"],
		["image", "image"],
		["switch", "switch"],
		["checkbox", "checkbox"],
		["slider", "slider"],
		["link", "link"],
		["cell", "listitem"],
		["list", "list"],
		["scrollview", "group"],
		["tab", "tab"],
		["tabbar", "tablist"],
		["alert", "alert"],
		["sheet", "dialog"],
		["navbar", "navigation"],
		["toolbar", "group"],
		["keyboard", "other"],
		["window", "other"],
		["application", "other"],
		["other", "other"],
	];
	for (const [role, expected] of cases) {
		test(`${role} -> ${expected}`, () => {
			expect(roleResolver.resolveRole(elementFixtures.el(role)).role).toBe(expected);
		});
	}

	test("every result is in the query vocabulary", () => {
		for (const [role] of cases)
			expect(roleResolver.isQueryRole(roleResolver.resolveRole(elementFixtures.el(role)).role)).toBe(true);
	});
});

describe("resolveRole: iOS", () => {
	test("button trait upgrades Other", () => {
		expect(roleResolver.resolveRole(elementFixtures.el("other", { traits: ["button"] })).role).toBe("button");
	});

	test("link, header, image and adjustable traits upgrade Other", () => {
		expect(roleResolver.resolveRole(elementFixtures.el("other", { traits: ["link"] })).role).toBe("link");
		expect(roleResolver.resolveRole(elementFixtures.el("other", { traits: ["header"] })).role).toBe("heading");
		expect(roleResolver.resolveRole(elementFixtures.el("other", { traits: ["image"] })).role).toBe("image");
		expect(roleResolver.resolveRole(elementFixtures.el("other", { traits: ["adjustable"] })).role).toBe("slider");
	});

	test("header trait makes a StaticText a heading; button trait makes it a button", () => {
		expect(roleResolver.resolveRole(elementFixtures.el("text", { traits: ["header"] })).role).toBe("heading");
		expect(roleResolver.resolveRole(elementFixtures.el("text", { traits: ["button"] })).role).toBe("button");
	});

	test("header outranks button when both are set", () => {
		expect(roleResolver.resolveRole(elementFixtures.el("other", { traits: ["button", "header"] })).role).toBe(
			"heading"
		);
	});

	test("traits do not demote a specific role", () => {
		expect(roleResolver.resolveRole(elementFixtures.el("switch", { traits: ["button"] })).role).toBe("switch");
		expect(roleResolver.resolveRole(elementFixtures.el("textfield", { traits: ["button"] })).role).toBe("textbox");
	});

	test("buttons inside a tab bar are tabs", () => {
		const bar = elementFixtures.el("tabbar");
		expect(roleResolver.resolveRole(elementFixtures.el("button"), bar).role).toBe("tab");
		expect(roleResolver.resolveRole(elementFixtures.el("button"), elementFixtures.el("navbar")).role).toBe("button");
	});
});

describe("resolveRole: React Native iOS value prefixes", () => {
	test("checkbox, unchecked on an Other", () => {
		const resolved = roleResolver.resolveRole(elementFixtures.el("other", { value: "checkbox, unchecked" }));
		expect(resolved.role).toBe("checkbox");
		expect(resolved.spelled).toEqual({ checked: false, role: "checkbox", value: undefined });
	});

	test("radio button, checked keeps a trailing app value", () => {
		const resolved = roleResolver.resolveRole(
			elementFixtures.el("other", { value: "radio button, checked, Pro plan" })
		);
		expect(resolved.role).toBe("radio");
		expect(resolved.spelled).toEqual({ checked: true, role: "radio", value: "Pro plan" });
	});

	test("expanded / collapsed words", () => {
		expect(
			roleResolver.resolveRole(elementFixtures.el("other", { value: "menu item, expanded" })).spelled?.expanded
		).toBe(true);
		expect(
			roleResolver.resolveRole(elementFixtures.el("other", { value: "tab list, collapsed" })).spelled?.expanded
		).toBe(false);
	});

	test("only an Other carries the encoding", () => {
		const resolved = roleResolver.resolveRole(elementFixtures.el("textfield", { value: "checkbox, unchecked" }));
		expect(resolved.role).toBe("textbox");
		expect(resolved.spelled).toBeUndefined();
	});

	test("an ordinary value is not a spelled value", () => {
		expect(roleResolver.parseSpelledValue("hello, world")).toBeUndefined();
		expect(roleResolver.parseSpelledValue(undefined)).toBeUndefined();
	});

	test("spelled role outranks traits", () => {
		expect(
			roleResolver.resolveRole(elementFixtures.el("other", { value: "switch, checked", traits: ["button"] })).role
		).toBe("switch");
	});
});

describe("resolveRole: Android", () => {
	const android = (
		rawType: string,
		props: Parameters<typeof elementFixtures.el>[1] = {},
		role: Parameters<typeof elementFixtures.el>[0] = "other"
	) => roleResolver.resolveRole(elementFixtures.el(role, { rawType, ...props }));

	test("widget classes", () => {
		expect(android("android.widget.RadioButton").role).toBe("radio");
		expect(android("android.widget.CheckBox").role).toBe("checkbox");
		expect(android("android.widget.Switch").role).toBe("switch");
		expect(android("androidx.appcompat.widget.SwitchCompat").role).toBe("switch");
		expect(android("android.widget.SeekBar").role).toBe("slider");
		expect(android("android.widget.EditText").role).toBe("textbox");
		expect(android("android.widget.ImageButton").role).toBe("button");
		expect(android("android.widget.TextView").role).toBe("text");
		expect(android("androidx.recyclerview.widget.RecyclerView").role).toBe("list");
		expect(android("android.widget.FrameLayout").role).toBe("group");
		expect(android("android.view.ViewGroup").role).toBe("group");
	});

	test("heading flag", () => {
		expect(android("android.widget.TextView", { traits: ["heading"] }, "text").role).toBe("heading");
	});

	test("clickable view groups are buttons (React Native Pressable)", () => {
		expect(android("android.view.ViewGroup", { traits: ["clickable"] }).role).toBe("button");
		expect(android("android.widget.ScrollView", { traits: ["clickable"] }).role).toBe("group");
	});

	test("checkable view groups are checkboxes", () => {
		expect(android("android.view.ViewGroup", { traits: ["clickable", "checkable"] }).role).toBe("checkbox");
	});

	test("unknown class falls back to the driver role", () => {
		expect(android("com.acme.Fancy", {}, "slider").role).toBe("slider");
	});

	test("an edit text whose driver role is text is still a textbox", () => {
		expect(android("android.widget.EditText", {}, "text").role).toBe("textbox");
	});
});

describe("role helpers", () => {
	test("vocabulary matches the plan", () => {
		expect([...QUERY_ROLES]).toEqual([
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
		]);
	});

	test("isQueryRole", () => {
		expect(roleResolver.isQueryRole("button")).toBe(true);
		expect(roleResolver.isQueryRole("textfield")).toBe(false);
	});

	test("isInteractiveRole", () => {
		for (const role of [
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
		] as const)
			expect(roleResolver.isInteractiveRole(role)).toBe(true);
		for (const role of ["text", "image", "group", "list", "other", "heading"] as const)
			expect(roleResolver.isInteractiveRole(role)).toBe(false);
	});
});
