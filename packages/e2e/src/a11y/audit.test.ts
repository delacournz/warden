import { describe, expect, test } from "bun:test";
import { A11Y_RULE_IDS } from "@delacour/warden-core/a11y/a11y.config";
import { ANDROID_SETTINGS, IOS_SETTINGS, snapshotOf } from "./a11y.fixture";
import type { A11yAuditResult, A11yIssue, A11yRuleId } from "./a11y.types";
import { failing, formatIssues, mergeIssues, runAudit, WARDEN_RULES } from "./audit";

const KNOWN: Record<A11yRuleId, true> = {
	"missing-name": true,
	"image-no-name": true,
	"target-size": true,
	"target-size-platform": true,
	"duplicate-name": true,
	"role-in-name": true,
	"label-in-name": true,
	"hidden-focusable": true,
	"text-clipped": true,
	native: true,
};

test("core's rule id list matches A11yRuleId and every warden rule is registered", () => {
	expect([...A11Y_RULE_IDS].map(String).sort()).toEqual(Object.keys(KNOWN).sort());
	expect(WARDEN_RULES.map((r) => String(r.id)).sort()).toEqual(
		Object.keys(KNOWN)
			.filter((k) => k !== "native")
			.sort()
	);
});

describe("runAudit", () => {
	test("iOS settings fixture: unnamed avatar and placeholder-only field are the only errors", () => {
		const res = runAudit(IOS_SETTINGS, "ios");
		expect(res.sources).toEqual(["warden"]);
		expect(res.skipped).toEqual([]);
		expect(res.checked).toBeGreaterThan(5);
		const errors = failing(res);
		expect(errors.map((i) => `${i.rule}:${i.identifier ?? ""}`)).toEqual([
			"image-no-name:settings-avatar",
			"missing-name:settings-name",
		]);
	});

	test("android fixture also catches the unnamed avatar", () => {
		expect(failing(runAudit(ANDROID_SETTINGS, "android")).map((i) => i.rule)).toContain("image-no-name");
	});

	test("ignore by rule and by identifier", () => {
		const base = runAudit(IOS_SETTINGS, "ios");
		expect(
			runAudit(IOS_SETTINGS, "ios", { ignore: [{ rule: "image-no-name" }] }).issues.some(
				(i) => i.rule === "image-no-name"
			)
		).toBe(false);
		const byId = runAudit(IOS_SETTINGS, "ios", { ignore: [{ rule: "image-no-name", identifier: "settings-avatar" }] });
		expect(byId.issues.length).toBe(base.issues.length - 1);
		const other = runAudit(IOS_SETTINGS, "ios", { ignore: [{ rule: "image-no-name", identifier: "nope" }] });
		expect(other.issues.length).toBe(base.issues.length);
	});

	test("rules limits what runs", () => {
		const res = runAudit(IOS_SETTINGS, "ios", { rules: ["image-no-name"] });
		expect(new Set(res.issues.map((i) => i.rule))).toEqual(new Set(["image-no-name"]));
	});

	test("order is reading order, then rule", () => {
		const snap = snapshotOf("ios", [
			{ role: "image", rawType: "Image", frame: { x: 0, y: 50, width: 40, height: 40 } },
			{
				role: "button",
				rawType: "Button",
				traits: ["button"],
				frame: { x: 0, y: 300, width: 100, height: 50 },
				label: "Low button",
			},
			{ role: "image", rawType: "Image", identifier: "late", frame: { x: 0, y: 500, width: 40, height: 40 } },
		]);
		const res = runAudit(snap, "ios");
		const rules = res.issues.map((i) => i.rule);
		expect(rules).toEqual(["image-no-name", "role-in-name", "image-no-name"]);
		expect(res.issues.map((i) => i.identifier)).toEqual([undefined, undefined, "late"]);
	});

	test("deterministic", () => {
		expect(runAudit(IOS_SETTINGS, "ios")).toEqual(runAudit(IOS_SETTINGS, "ios"));
	});
});

describe("failing + minSeverity", () => {
	const res: A11yAuditResult = {
		checked: 2,
		sources: ["warden"],
		skipped: [],
		issues: [
			{ rule: "missing-name", severity: "error", source: "warden", message: "e" },
			{ rule: "duplicate-name", severity: "warning", source: "warden", message: "w" },
		],
	};
	test("defaults to error only", () => {
		expect(failing(res).map((i) => i.message)).toEqual(["e"]);
		expect(failing(res, "warning")).toHaveLength(2);
	});
});

describe("mergeIssues", () => {
	const warden: A11yIssue = {
		rule: "target-size",
		severity: "error",
		wcag: "2.5.8",
		source: "warden",
		identifier: "b",
		elementId: "0.1",
		message: "small",
	};
	const base: A11yAuditResult = { issues: [warden], checked: 3, sources: ["warden"], skipped: [] };
	test("same element + wcag across sources keeps warden's and notes the other", () => {
		const native: A11yIssue = {
			rule: "native",
			severity: "error",
			wcag: "2.5.8",
			source: "xcuitest",
			identifier: "b",
			message: "hit region",
		};
		const merged = mergeIssues(base, [native]);
		expect(merged.issues).toHaveLength(1);
		expect(merged.issues[0]?.source).toBe("warden");
		expect(merged.issues[0]?.message).toContain("also reported by xcuitest");
		expect(merged.sources).toEqual(["warden", "xcuitest"]);
	});
	test("different element or wcag is added; skipped is recorded", () => {
		const a: A11yIssue = {
			rule: "native",
			severity: "warning",
			wcag: "1.4.3",
			source: "atf",
			identifier: "b",
			message: "contrast",
		};
		const b: A11yIssue = {
			rule: "native",
			severity: "error",
			wcag: "2.5.8",
			source: "atf",
			identifier: "other",
			message: "small",
		};
		const merged = mergeIssues(base, [a, b], [{ source: "xcuitest", reason: "no runner" }]);
		expect(merged.issues).toHaveLength(3);
		expect(merged.skipped).toEqual([{ source: "xcuitest", reason: "no runner" }]);
		expect(mergeIssues(base, [a]).issues).toHaveLength(2);
	});
	test("does not mutate base; repeat merge does not stack notes", () => {
		const native: A11yIssue = {
			rule: "native",
			severity: "error",
			wcag: "2.5.8",
			source: "xcuitest",
			identifier: "b",
			message: "x",
		};
		const once = mergeIssues(base, [native]);
		const twice = mergeIssues(once, [native]);
		expect(base.issues[0]?.message).toBe("small");
		expect(twice.issues[0]?.message).toBe(once.issues[0]?.message);
	});
});

describe("formatIssues", () => {
	test("table with header, and a clean line when empty", () => {
		const out = formatIssues(runAudit(IOS_SETTINGS, "ios"));
		expect(out.split("\n")[0]).toContain("a11y audit:");
		expect(out).toContain("image-no-name");
		expect(out).toContain("settings-avatar");
		const clean = formatIssues({
			issues: [],
			checked: 1,
			sources: ["warden"],
			skipped: [{ source: "atf", reason: "no dex" }],
		});
		expect(clean).toContain("0 issues");
		expect(clean).toContain("skipped atf: no dex");
	});
});
