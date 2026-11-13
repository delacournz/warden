import { describe, expect, test } from "bun:test";
import type { Platform, Rect, Snapshot } from "../../driver/driver.types";
import { snapshotOf } from "../a11y.fixture";
import type { A11yIssue, A11yRuleId } from "../a11y.types";
import { runAudit } from "../audit";

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
type Spec = Parameters<typeof snapshotOf>[1][number];

function issuesOf(
	rule: A11yRuleId,
	platform: Platform,
	specs: Spec[],
	opts: Parameters<typeof runAudit>[2] = {}
): readonly A11yIssue[] {
	return runAudit(snapshotOf(platform, specs), platform, { ...opts, rules: [rule] }).issues;
}

const btn = (over: Spec): Spec => ({
	role: "button",
	rawType: "Button",
	traits: ["button"],
	frame: r(20, 100, 200, 60),
	...over,
});
const dp = (n: number): number => n * 2.75;

describe("missing-name", () => {
	test("flags a nameless button, passes a named one", () => {
		const bad = issuesOf("missing-name", "ios", [btn({ identifier: "x" })]);
		expect(bad).toHaveLength(1);
		expect(bad[0]).toMatchObject({ severity: "error", wcag: "4.1.2", source: "warden", identifier: "x" });
		expect(issuesOf("missing-name", "ios", [btn({ label: "Save" })])).toEqual([]);
	});
	test("button named by its text children passes; hidden nodes are not reachable", () => {
		const named = btn({ children: [{ role: "text", rawType: "StaticText", label: "Save" }] });
		expect(issuesOf("missing-name", "ios", [named])).toEqual([]);
		expect(issuesOf("missing-name", "ios", [btn({ hidden: true })])).toEqual([]);
	});
	test("android focusable view without a name", () => {
		const bad = issuesOf("missing-name", "android", [
			{ role: "other", rawType: "android.view.View", a11y: { focusable: true } },
		]);
		expect(bad).toHaveLength(1);
	});
	test("android scroll container is focusable but not a stop: no name needed", () => {
		const scroller: Spec = {
			role: "scrollview",
			rawType: "android.widget.ScrollView",
			traits: ["scrollable"],
			a11y: { focusable: true },
		};
		expect(issuesOf("missing-name", "android", [scroller])).toEqual([]);
		const clickable: Spec = { ...scroller, traits: ["scrollable", "clickable"] };
		expect(issuesOf("missing-name", "android", [clickable])).toHaveLength(1);
	});
});

describe("image-no-name", () => {
	const img = (over: Spec): Spec => ({ role: "image", rawType: "Image", frame: r(0, 0, 48, 48), ...over });
	test("flags unnamed image", () => {
		expect(issuesOf("image-no-name", "ios", [img({})])[0]).toMatchObject({ wcag: "1.1.1", severity: "error" });
	});
	test("named, decorative (important false) and hidden pass", () => {
		expect(issuesOf("image-no-name", "ios", [img({ label: "Avatar" })])).toEqual([]);
		expect(issuesOf("image-no-name", "ios", [img({ a11y: { important: false } })])).toEqual([]);
		expect(issuesOf("image-no-name", "ios", [img({ hidden: true })])).toEqual([]);
	});
});

describe("target-size", () => {
	test("small isolated target passes by the spacing exception", () => {
		const lone = btn({ label: "x", frame: r(20, 100, 20, 20) });
		expect(issuesOf("target-size", "ios", [lone])).toEqual([]);
	});
	test("small target with a neighbour inside 24pt fails (ios pt)", () => {
		const a = btn({ label: "a", frame: r(20, 100, 20, 20) });
		const b = btn({ label: "b", frame: r(40, 100, 20, 20) });
		const got = issuesOf("target-size", "ios", [a, b]);
		expect(got.length).toBeGreaterThan(0);
		expect(got[0]).toMatchObject({ severity: "error", wcag: "2.5.8" });
	});
	test("small target next to a large one fails", () => {
		const small = btn({ label: "s", frame: r(20, 100, 16, 16) });
		const big = btn({ label: "b", frame: r(32, 90, 200, 44) });
		expect(issuesOf("target-size", "ios", [small, big]).map((i) => i.message)).toHaveLength(1);
	});
	test("android converts px to dp", () => {
		const mk = (px: number, x: number): Spec =>
			btn({ label: String(x), rawType: "android.widget.Button", traits: ["clickable"], frame: r(x, 400, px, px) });
		const dpOk = [mk(dp(24), 40), mk(dp(24), 40 + dp(24) + 5)];
		expect(issuesOf("target-size", "android", dpOk)).toEqual([]);
		const small = [mk(dp(20), 40), mk(dp(20), 40 + dp(20) + 5)];
		expect(issuesOf("target-size", "android", small).length).toBeGreaterThan(0);
	});
	test("disabled and nested targets are exempt", () => {
		const a = btn({ label: "a", frame: r(20, 100, 20, 20), enabled: false });
		const b = btn({ label: "b", frame: r(40, 100, 20, 20) });
		expect(issuesOf("target-size", "ios", [a, b])).toEqual([]);
		const nested = btn({
			label: "p",
			frame: r(20, 100, 30, 30),
			children: [btn({ label: "c", frame: r(25, 105, 20, 20) })],
		});
		expect(issuesOf("target-size", "ios", [nested])).toEqual([]);
	});
});

describe("target-size-platform", () => {
	test("warns under 44pt on iOS, passes at 44", () => {
		expect(issuesOf("target-size-platform", "ios", [btn({ label: "a", frame: r(0, 0, 100, 40) })])[0]).toMatchObject({
			severity: "warning",
		});
		expect(issuesOf("target-size-platform", "ios", [btn({ label: "a", frame: r(0, 0, 100, 44) })])).toEqual([]);
	});
	test("Android threshold is 48dp", () => {
		const mk = (h: number): Spec =>
			btn({ label: "a", rawType: "android.widget.Button", traits: ["clickable"], frame: r(0, 0, dp(100), dp(h)) });
		expect(issuesOf("target-size-platform", "android", [mk(46)])).toHaveLength(1);
		expect(issuesOf("target-size-platform", "android", [mk(48)])).toEqual([]);
	});
	test("a target already failing target-size is not reported twice", () => {
		const a = btn({ label: "a", frame: r(20, 100, 20, 20) });
		const b = btn({ label: "b", frame: r(40, 100, 20, 20) });
		expect(issuesOf("target-size-platform", "ios", [a, b])).toEqual([]);
	});
});

describe("duplicate-name", () => {
	test("same name, different frames and ids warns once", () => {
		const got = issuesOf("duplicate-name", "ios", [
			btn({ label: "Delete", identifier: "d1" }),
			btn({ label: "delete ", identifier: "d2", frame: r(20, 200, 200, 60) }),
		]);
		expect(got).toHaveLength(1);
		expect(got[0]).toMatchObject({ severity: "warning", wcag: "2.4.6", identifier: "d2" });
	});
	test("same identifier, same frame or different names pass", () => {
		expect(
			issuesOf("duplicate-name", "ios", [
				btn({ label: "Delete", identifier: "d" }),
				btn({ label: "Delete", identifier: "d", frame: r(20, 200, 200, 60) }),
			])
		).toEqual([]);
		expect(issuesOf("duplicate-name", "ios", [btn({ label: "Delete" }), btn({ label: "Delete" })])).toEqual([]);
		expect(
			issuesOf("duplicate-name", "ios", [btn({ label: "Delete" }), btn({ label: "Edit", frame: r(20, 200, 200, 60) })])
		).toEqual([]);
	});
});

describe("role-in-name", () => {
	test("button and image role words", () => {
		expect(issuesOf("role-in-name", "ios", [btn({ label: "Save button" })])).toHaveLength(1);
		expect(issuesOf("role-in-name", "ios", [btn({ label: "Save btn" })])).toHaveLength(1);
		expect(issuesOf("role-in-name", "ios", [{ role: "image", rawType: "Image", label: "Profile icon" }])).toHaveLength(
			1
		);
	});
	test("clean names and substrings pass", () => {
		expect(issuesOf("role-in-name", "ios", [btn({ label: "Save" })])).toEqual([]);
		expect(issuesOf("role-in-name", "ios", [btn({ label: "Buttonwood Lane" })])).toEqual([]);
		expect(issuesOf("role-in-name", "ios", [{ role: "text", rawType: "StaticText", label: "Image gallery" }])).toEqual(
			[]
		);
	});
});

describe("label-in-name", () => {
	test("visible text missing from a separate label fails (android)", () => {
		const bad = btn({ rawType: "android.view.View", traits: ["clickable"], label: "Submit order", text: "Buy now" });
		const got = issuesOf("label-in-name", "android", [bad]);
		expect(got[0]).toMatchObject({ severity: "error", wcag: "2.5.3" });
	});
	test("contained (case/space-insensitive) passes", () => {
		const ok = btn({
			rawType: "android.view.View",
			traits: ["clickable"],
			label: "Please BUY  now today",
			text: "buy now",
		});
		expect(issuesOf("label-in-name", "android", [ok])).toEqual([]);
	});
	test('punctuation in the name is ignored ("Walk dog, Active" contains "Walk dog Active")', () => {
		const ok = btn({
			rawType: "android.view.View",
			traits: ["clickable"],
			label: "Walk dog, Active",
			text: "Walk dog Active",
		});
		expect(issuesOf("label-in-name", "android", [ok])).toEqual([]);
	});
	test("ios: static text children vs label", () => {
		const child = (t: string) => ({ role: "text" as const, rawType: "StaticText", label: t });
		expect(issuesOf("label-in-name", "ios", [btn({ label: "Checkout", children: [child("Pay")] })])).toHaveLength(1);
		expect(
			issuesOf("label-in-name", "ios", [btn({ label: "Edit profile", children: [child("Edit"), child("profile")] })])
		).toEqual([]);
	});
	test("no label (name from text) cannot fail", () => {
		expect(
			issuesOf("label-in-name", "android", [
				btn({ rawType: "android.widget.Button", traits: ["clickable"], text: "Go" }),
			])
		).toEqual([]);
	});
});

describe("hidden-focusable", () => {
	const fo = { focusable: true, important: true } as const;
	test("hidden, zero-size and off-screen focusable nodes warn", () => {
		const got = issuesOf("hidden-focusable", "ios", [
			btn({ label: "a", hidden: true, a11y: fo }),
			btn({ label: "b", frame: r(0, 0, 0, 0), a11y: fo }),
			btn({ label: "c", frame: r(0, 2000, 100, 40), a11y: fo }),
		]);
		expect(got).toHaveLength(3);
		expect(got[0]?.severity).toBe("warning");
	});
	test("visible, unfocusable or unimportant pass", () => {
		expect(issuesOf("hidden-focusable", "ios", [btn({ label: "a", a11y: fo })])).toEqual([]);
		expect(issuesOf("hidden-focusable", "ios", [btn({ label: "a", hidden: true })])).toEqual([]);
		expect(
			issuesOf("hidden-focusable", "ios", [
				btn({ label: "a", hidden: true, a11y: { focusable: true, important: false } }),
			])
		).toEqual([]);
	});
});

describe("text-clipped", () => {
	const text = (over: Spec): Spec => ({
		role: "text",
		rawType: "StaticText",
		label: "Hello",
		frame: r(30, 120, 100, 20),
		...over,
	});
	const box = (child: Spec): Spec => ({
		role: "other",
		rawType: "View",
		frame: r(20, 100, 200, 60),
		children: [child],
	});
	test("does nothing below accessibility-medium", () => {
		const s = [box(text({ label: "Very long…" }))];
		expect(issuesOf("text-clipped", "ios", s)).toEqual([]);
		expect(issuesOf("text-clipped", "ios", s, { textSize: "extra-extra-extra-large" })).toEqual([]);
	});
	test("ellipsis and overflow warn at accessibility-medium+", () => {
		const o = { textSize: "accessibility-medium" } as const;
		expect(issuesOf("text-clipped", "ios", [box(text({ label: "Very long…" }))], o)).toHaveLength(1);
		expect(issuesOf("text-clipped", "ios", [box(text({ frame: r(30, 120, 300, 20) }))], o)).toHaveLength(1);
		expect(issuesOf("text-clipped", "android", [box(text({ label: "Hi..." }))], { textSize: 1.6 })).toHaveLength(1);
	});
	test("fitting text and scroll containers pass", () => {
		const o = { textSize: "accessibility-large" } as const;
		expect(issuesOf("text-clipped", "ios", [box(text({}))], o)).toEqual([]);
		const scroll: Spec = {
			role: "scrollview",
			rawType: "ScrollView",
			frame: r(20, 100, 200, 60),
			children: [text({ frame: r(30, 120, 100, 400) })],
		};
		expect(issuesOf("text-clipped", "ios", [scroll], o)).toEqual([]);
	});
});

export type { Snapshot };
