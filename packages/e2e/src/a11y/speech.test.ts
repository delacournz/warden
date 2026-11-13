import { describe, expect, test } from "bun:test";
import { ANDROID_SETTINGS, el } from "./a11y.fixture";
import { announce } from "./speech";

describe("announce (VoiceOver model)", () => {
	test("switch with label: label, switch button, on, hint", () => {
		const a = announce(
			el("ios", { role: "switch", label: "Notifications", value: "1", a11y: { hint: "Double tap to toggle" } }),
			"ios"
		);
		expect(a.text).toBe("Notifications, switch button, on, Double tap to toggle");
		expect(a.parts).toEqual({
			label: "Notifications",
			role: "switch button",
			state: ["on"],
			hint: "Double tap to toggle",
		});
		expect(a.source).toBe("simulated");
		expect(a.platform).toBe("ios");
	});

	test("switch off from value 0", () => {
		expect(announce(el("ios", { role: "switch", label: "Dark mode", value: "0" }), "ios").text).toBe(
			"Dark mode, switch button, off"
		);
	});

	test("heading trait", () => {
		expect(
			announce(el("ios", { role: "text", label: "Settings", traits: ["static-text", "header"] }), "ios").text
		).toBe("Settings, heading");
	});

	test("plain static text has no role word", () => {
		expect(announce(el("ios", { role: "text", label: "Hello" }), "ios").text).toBe("Hello");
	});

	test("disabled button is dimmed", () => {
		expect(
			announce(el("ios", { role: "button", label: "Delete", traits: ["button", "not-enabled"], enabled: false }), "ios")
				.text
		).toBe("Delete, button, dimmed");
	});

	test("selected tab", () => {
		expect(announce(el("ios", { role: "tab", label: "Home", selected: true }), "ios").text).toBe("Home, tab, selected");
	});

	test("image without label is just the role", () => {
		expect(announce(el("ios", { role: "image", traits: ["image"] }), "ios").text).toBe("image");
	});

	test("adjustable reads value", () => {
		expect(
			announce(el("ios", { role: "slider", label: "Volume", value: "50%", traits: ["adjustable"] }), "ios").text
		).toBe("Volume, 50%, adjustable");
	});

	test("text field with only a placeholder speaks it as value", () => {
		const a = announce(el("ios", { role: "textfield", placeholder: "Display name" }), "ios");
		expect(a.text).toBe("Display name, text field");
		expect(a.parts.value).toBe("Display name");
	});

	test("text field with label and value", () => {
		expect(announce(el("ios", { role: "textfield", label: "Name", value: "Ada" }), "ios").text).toBe(
			"Name, Ada, text field"
		);
	});

	test("secure field never reads its value", () => {
		expect(announce(el("ios", { role: "securefield", label: "Password", value: "••••" }), "ios").text).toBe(
			"Password, secure text field"
		);
	});

	test("link and expanded state", () => {
		expect(announce(el("ios", { role: "button", label: "More", traits: ["link", "collapsed"] }), "ios").text).toBe(
			"More, link, collapsed"
		);
	});

	test("nested texts merge into a pressable with no label", () => {
		const a = announce(
			el("ios", {
				role: "button",
				traits: ["button"],
				children: [
					{ role: "text", label: "Edit" },
					{ role: "text", label: "profile" },
				],
			}),
			"ios"
		);
		expect(a.text).toBe("Edit profile, button");
	});

	test("hints can be turned off", () => {
		expect(
			announce(el("ios", { role: "button", label: "Go", a11y: { hint: "Opens" } }), "ios", { hints: false }).text
		).toBe("Go, button");
	});
});

describe("announce (TalkBack model)", () => {
	test("switch: state, name, role, hint", () => {
		const a = announce(
			el("android", {
				role: "switch",
				text: "Notifications",
				checked: true,
				traits: ["clickable", "checkable", "checked"],
				a11y: { hint: "Double tap to toggle" },
			}),
			"android"
		);
		expect(a.text).toBe("on, Notifications, switch, Double tap to toggle");
		expect(a.platform).toBe("android");
		expect(a.source).toBe("simulated");
	});

	test("switch off", () => {
		expect(
			announce(el("android", { role: "switch", text: "Dark mode", checked: false, traits: ["checkable"] }), "android")
				.text
		).toBe("off, Dark mode, switch");
	});

	test("checkbox states", () => {
		expect(
			announce(el("android", { role: "checkbox", text: "Agree", checked: false, traits: ["checkable"] }), "android")
				.text
		).toBe("not checked, Agree, checkbox");
		expect(
			announce(
				el("android", { role: "checkbox", text: "Agree", checked: true, traits: ["checkable", "checked"] }),
				"android"
			).text
		).toBe("checked, Agree, checkbox");
	});

	test("selected comes first", () => {
		expect(announce(el("android", { role: "tab", text: "Home", selected: true }), "android").text).toBe(
			"selected, Home, tab"
		);
	});

	test("disabled button", () => {
		const a = announce(
			el("android", { role: "button", text: "Delete", enabled: false, traits: ["clickable"] }),
			"android"
		);
		expect(a.text).toBe("Delete, button, disabled");
		expect(a.parts.state).toEqual(["disabled"]);
	});

	test("heading", () => {
		expect(announce(el("android", { role: "text", text: "Settings", traits: ["heading"] }), "android").text).toBe(
			"Settings, heading"
		);
	});

	test("edit box uses typed text, else hint text", () => {
		expect(announce(el("android", { role: "textfield", value: "Ada", placeholder: "Name" }), "android").text).toBe(
			"Ada, edit box"
		);
		expect(announce(el("android", { role: "textfield", value: "", placeholder: "Display name" }), "android").text).toBe(
			"Display name, edit box"
		);
	});

	test("content-desc wins over text; nested texts merge with commas", () => {
		expect(announce(el("android", { role: "image", label: "Avatar of Ada", text: "x" }), "android").text).toBe(
			"Avatar of Ada, image"
		);
		const row = ANDROID_SETTINGS.flat.find((e) => e.id === "0.4");
		if (!row) throw new Error("fixture");
		expect(announce(row, "android").text).toBe("Edit, profile, button");
	});
});
