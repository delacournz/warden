import { describe, expect, test } from "bun:test";
import { ANDROID_SETTINGS, IOS_SETTINGS, snapshotOf } from "./a11y.fixture";
import { readingOrder } from "./order";

const texts = (s: Parameters<typeof readingOrder>[0], p: "ios" | "android"): string[] =>
	readingOrder(s, p).map((a) => a.text);

describe("readingOrder golden: iOS settings", () => {
	test("announcements in order; unlabeled image skipped, children merged", () => {
		expect(texts(IOS_SETTINGS, "ios")).toEqual([
			"Settings, heading",
			"Notifications, switch button, on, Double tap to toggle",
			"Dark mode, switch button, off",
			"Edit profile, button",
			"Delete account, button, dimmed",
			"Display name, text field",
			"Volume, 50%, adjustable",
		]);
	});

	test("every entry is simulated and carries ids", () => {
		const list = readingOrder(IOS_SETTINGS, "ios");
		expect(list.every((a) => a.source === "simulated")).toBe(true);
		expect(list.find((a) => a.identifier === "settings-notifications")?.id).toBe("0.1");
	});
});

describe("readingOrder golden: Android settings", () => {
	test("announcements in tree order; important=false and unlabeled image skipped", () => {
		expect(texts(ANDROID_SETTINGS, "android")).toEqual([
			"Settings, heading",
			"on, Notifications, switch, Double tap to toggle",
			"off, Dark mode, switch",
			"Edit, profile, button",
			"Delete account, button, disabled",
			"Display name, edit box",
		]);
	});
});

describe("readingOrder rules", () => {
	test("iOS row-major: left-to-right within a row even when tree order differs", () => {
		const snap = snapshotOf("ios", [
			{
				role: "window",
				children: [
					{ role: "button", label: "B", frame: { x: 200, y: 100, width: 100, height: 40 } },
					{ role: "button", label: "C", frame: { x: 20, y: 200, width: 100, height: 40 } },
					{ role: "button", label: "A", frame: { x: 20, y: 104, width: 100, height: 40 } },
				],
			},
		]);
		expect(texts(snap, "ios")).toEqual(["A, button", "B, button", "C, button"]);
	});

	test("Android keeps tree order", () => {
		const snap = snapshotOf("android", [
			{
				children: [
					{ role: "button", text: "B", traits: ["clickable"], frame: { x: 500, y: 100, width: 100, height: 40 } },
					{ role: "button", text: "A", traits: ["clickable"], frame: { x: 20, y: 104, width: 100, height: 40 } },
				],
			},
		]);
		expect(texts(snap, "android")).toEqual(["B, button", "A, button"]);
	});

	test("iOS a11y.order wins over frames", () => {
		const snap = snapshotOf("ios", [
			{
				children: [
					{ role: "button", label: "top", frame: { x: 0, y: 10, width: 50, height: 40 } },
					{ role: "button", label: "bottom", frame: { x: 0, y: 300, width: 50, height: 40 }, a11y: { order: 0 } },
				],
			},
		]);
		expect(texts(snap, "ios")).toEqual(["bottom, button", "top, button"]);
	});

	test("hidden, off-screen and zero-size nodes are skipped", () => {
		const snap = snapshotOf("ios", [
			{
				children: [
					{ role: "text", label: "hidden", hidden: true },
					{ role: "text", label: "offscreen", frame: { x: 0, y: 5000, width: 50, height: 20 } },
					{ role: "text", label: "empty", frame: { x: 0, y: 0, width: 0, height: 0 } },
					{ role: "text", label: "shown", frame: { x: 0, y: 0, width: 50, height: 20 } },
				],
			},
		]);
		expect(texts(snap, "ios")).toEqual(["shown"]);
	});

	test("focusable parent with a focusable child: no merge, both listed", () => {
		const snap = snapshotOf("android", [
			{
				role: "button",
				traits: ["clickable"],
				text: "Card",
				children: [
					{ role: "button", text: "Inner", traits: ["clickable"], frame: { x: 0, y: 0, width: 10, height: 10 } },
				],
			},
		]);
		expect(texts(snap, "android")).toEqual(["Card, button", "Inner, button"]);
	});
});

describe("readingOrder: iOS traversal from the injected walk", () => {
	const cell = (label: string, x: number, y: number, traversal?: number) => ({
		role: "button" as const,
		label,
		traits: ["button"],
		frame: { x, y, width: 100, height: 40 },
		...(traversal === undefined ? {} : { a11y: { traversal } }),
	});

	test("every reachable node has a traversal index: VoiceOver's own order wins over the frame guess", () => {
		const snap = snapshotOf("ios", [cell("Left", 0, 0, 1), cell("Right", 200, 0, 0)]);
		expect(texts(snap, "ios")).toEqual(["Right, button", "Left, button"]);
	});

	test("some nodes without one: falls back to the row-major guess", () => {
		const snap = snapshotOf("ios", [cell("Left", 0, 0, 1), cell("Right", 200, 0)]);
		expect(texts(snap, "ios")).toEqual(["Left, button", "Right, button"]);
	});

	test("Android ignores traversal", () => {
		const snap = snapshotOf("android", [cell("Left", 0, 0, 1), cell("Right", 200, 0, 0)]);
		expect(texts(snap, "android").map((t) => t.split(",")[0])).toEqual(["Left", "Right"]);
	});
});
