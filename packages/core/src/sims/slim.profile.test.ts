import { describe, expect, test } from "bun:test";
import { NEVER_DISABLE } from "./slim";
import {
	DEFAULT_SLIM_PROFILE,
	delta,
	describeCategories,
	desiredLabels,
	FORBIDDEN_LABELS,
	managedSet,
	SLIM_CATEGORIES,
	slimmableSet,
	validateProfile,
} from "./slim.profile";

describe("SLIM_CATEGORIES", () => {
	test("15 categories with unique ids", () => {
		expect(SLIM_CATEGORIES).toHaveLength(15);
		expect(new Set(SLIM_CATEGORIES.map((c) => c.id)).size).toBe(15);
	});

	test("labels are com.apple.* and unique within a category", () => {
		for (const category of SLIM_CATEGORIES) {
			for (const label of category.labels) expect(label).toMatch(/^com\.apple\.[\w.-]+$/);
			expect(new Set(category.labels).size).toBe(category.labels.length);
		}
	});

	test("no label is forbidden", () => {
		for (const label of slimmableSet()) expect(FORBIDDEN_LABELS).not.toContain(label);
		expect(FORBIDDEN_LABELS).toHaveLength(15);
	});

	test("no label matches NEVER_DISABLE; chronod is slimmable", () => {
		for (const label of slimmableSet()) {
			for (const pattern of NEVER_DISABLE) expect(pattern.test(label)).toBe(false);
		}
		expect(slimmableSet().has("com.apple.chronod")).toBe(true);
	});

	test("protected labels stay out of every category", () => {
		for (const label of ["com.apple.corespeechd", "com.apple.searchd", "com.apple.mobileassetd"]) {
			expect(slimmableSet().has(label)).toBe(false);
		}
	});

	test("alwaysEnabled labels are managed but never desired", () => {
		const always = SLIM_CATEGORIES.flatMap((c) => c.alwaysEnabled ?? []).map((a) => a.label);
		expect(always.sort()).toEqual(["com.apple.assistantd", "com.apple.gamed", "com.apple.sharingd"]);
		const desired = desiredLabels(DEFAULT_SLIM_PROFILE);
		for (const label of always) {
			expect(desired.has(label)).toBe(false);
			expect(managedSet().has(label)).toBe(true);
			expect(slimmableSet().has(label)).toBe(false);
		}
	});
});

describe("desiredLabels", () => {
	test("the default profile disables every slimmable label", () => {
		expect([...desiredLabels(DEFAULT_SLIM_PROFILE)].sort()).toEqual([...slimmableSet()].sort());
	});

	test("except: store keeps apsd, storekitd and the AMS labels shared with icloud", () => {
		const desired = desiredLabels({ except: ["store"], keep: [] });
		for (const id of ["apsd", "storekitd", "amsaccountsd", "amsengagementd", "amsondevicestoraged", "passd"]) {
			expect(desired.has(`com.apple.${id}`)).toBe(false);
		}
		expect(desired.has("com.apple.cloudd")).toBe(true);
		expect(desired.has("com.apple.appleaccountd")).toBe(true);
	});

	test("keep wins over everything", () => {
		const desired = desiredLabels({ except: [], keep: ["com.apple.swcd"] });
		expect(desired.has("com.apple.swcd")).toBe(false);
		expect(desired.has("com.apple.webprivacyd")).toBe(true);
	});
});

describe("delta", () => {
	const managed = managedSet();
	const desired = new Set(["com.apple.b", "com.apple.a"]);

	test("sorted, from a map or a set", () => {
		const fromMap = delta(new Map([["com.apple.a", true]]), desired, managed);
		expect(fromMap.toDisable).toEqual(["com.apple.b"]);
		expect(delta(new Set<string>(), desired, managed).toDisable).toEqual(["com.apple.a", "com.apple.b"]);
	});

	test("only managed labels are ever re-enabled", () => {
		const current = new Set(["com.apple.newsd", "com.apple.foreign", "com.apple.gamed"]);
		const res = delta(current, new Set(), managed);
		expect(res.toEnable).toEqual(["com.apple.gamed", "com.apple.newsd"]);
	});

	test("an enabled entry in the map is not disabled", () => {
		const res = delta(new Map([["com.apple.newsd", false]]), new Set(["com.apple.newsd"]), managed);
		expect(res.toDisable).toEqual(["com.apple.newsd"]);
		expect(res.toEnable).toEqual([]);
	});
});

describe("validateProfile", () => {
	test("accepts known ids and managed labels", () => {
		expect(validateProfile({ except: ["store"], keep: ["com.apple.swcd"] })).toEqual({
			success: true,
			data: { except: ["store"], keep: ["com.apple.swcd"] },
		});
	});

	test("names the bad category id", () => {
		const res = validateProfile({ except: ["store", "nope"], keep: [] });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("nope");
	});

	test("names the bad label (unknown, protected or forbidden)", () => {
		for (const label of ["com.apple.nope", "com.apple.searchd", "com.apple.dmd"]) {
			const res = validateProfile({ except: [], keep: [label] });
			expect(res.success).toBe(false);
			if (!res.success) expect(res.error).toContain(label);
		}
	});
});

describe("describeCategories", () => {
	test("id, name and label count per category", () => {
		const rows = describeCategories();
		expect(rows).toHaveLength(15);
		expect(rows[0]).toMatchObject({ id: "widgets", labelCount: 4 });
	});
});
