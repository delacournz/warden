import { afterEach, describe, expect, test } from "bun:test";
import { snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { cleanupHarnesses, harness, LOGIN } from "../commands/ui.testing";
import { CONDITION_AREAS, MENU_ROOT, type MenuState, menuKey, menuView } from "./conditions-menu";
import type { Key } from "./keys";

const press = (name: string, flags: { ctrl?: boolean; shift?: boolean } = {}): Key => ({
	name,
	ctrl: flags.ctrl ?? false,
	shift: flags.shift ?? false,
	seq: name,
});
const inArea = (area: string, index = 0): MenuState => ({ area, index });

describe("conditions menu data", () => {
	test("area keys and item keys are unique (a letter never means two things)", () => {
		const areaKeys = CONDITION_AREAS.map((a) => a.key);
		expect(new Set(areaKeys).size).toBe(areaKeys.length);
		for (const area of CONDITION_AREAS) {
			const keys = area.items.map((i) => i.key);
			expect(new Set(keys).size).toBe(keys.length);
		}
	});

	test("every item is a `warden ui` verb with its args, never a device flag", () => {
		for (const item of CONDITION_AREAS.flatMap((a) => a.items)) {
			expect(item.argv.length).toBeGreaterThan(0);
			expect(item.argv).not.toContain("--udid");
			expect(item.argv).not.toContain("--serial");
		}
	});

	test("biometrics enroll is iOS only (Android enrolment is baked into the golden)", () => {
		const bio = CONDITION_AREAS.find((a) => a.key === "b");
		const enroll = bio?.items.find((i) => i.argv.join(" ") === "biometrics enroll");
		expect(enroll?.platforms).toEqual(["ios"]);
	});
});

describe("menuKey: root", () => {
	test("an area letter opens that area", () => {
		expect(menuKey(MENU_ROOT, press("b"), "android")).toEqual({ kind: "move", menu: inArea("b") });
	});

	test("arrows move the selection, enter / right open it", () => {
		const down = menuKey(MENU_ROOT, press("down"), "android");
		expect(down).toEqual({ kind: "move", menu: { area: undefined, index: 1 } });
		const second = CONDITION_AREAS[1]?.key;
		expect(menuKey({ area: undefined, index: 1 }, press("enter"), "android")).toEqual({
			kind: "move",
			menu: inArea(second ?? ""),
		});
		expect(menuKey({ area: undefined, index: 1 }, press("right"), "android")).toEqual({
			kind: "move",
			menu: inArea(second ?? ""),
		});
	});

	test("up at the top stays; down at the bottom stays", () => {
		expect(menuKey(MENU_ROOT, press("up"), "android")).toEqual({ kind: "move", menu: MENU_ROOT });
		const last = CONDITION_AREAS.length - 1;
		expect(menuKey({ area: undefined, index: last }, press("down"), "android")).toEqual({
			kind: "move",
			menu: { area: undefined, index: last },
		});
	});

	test("esc, q and C close it", () => {
		for (const name of ["escape", "q", "C"])
			expect(menuKey(MENU_ROOT, press(name), "android")).toEqual({ kind: "close" });
	});

	test("an unknown key does nothing", () => {
		expect(menuKey(MENU_ROOT, press("Z"), "android")).toEqual({ kind: "none" });
	});
});

describe("menuKey: inside an area", () => {
	test("an item letter runs it", () => {
		const step = menuKey(inArea("b"), press("m"), "android");
		expect(step.kind === "run" && step.item.argv).toEqual(["biometrics", "match"]);
		expect(step.kind === "run" && step.area.label).toBe("biometrics");
	});

	test("enter runs the selected item", () => {
		const bio = menuView(inArea("b"), "android");
		const second = bio.rows[1];
		const step = menuKey(inArea("b", 1), press("enter"), "android");
		expect(step.kind === "run" && step.item.label).toBe(second?.label ?? "");
	});

	test("esc / left / backspace go back to the areas, keeping the area selected", () => {
		const index = CONDITION_AREAS.findIndex((a) => a.key === "n");
		for (const name of ["escape", "left", "backspace"])
			expect(menuKey(inArea("n"), press(name), "android")).toEqual({ kind: "move", menu: { area: undefined, index } });
	});

	test("q closes from inside an area", () => {
		expect(menuKey(inArea("n"), press("q"), "android")).toEqual({ kind: "close" });
	});

	test("an item for another platform is hidden and its letter does nothing", () => {
		expect(menuKey(inArea("b"), press("e"), "android")).toEqual({ kind: "none" });
		expect(menuView(inArea("b"), "android").rows.map((r) => r.label)).not.toContain("enroll");
	});

	test("ctrl keys are never shortcuts", () => {
		expect(menuKey(inArea("b"), press("m", { ctrl: true }), "android")).toEqual({ kind: "none" });
	});
});

describe("menuView", () => {
	test("iOS hides network and clock: warden dev launches the app without the dylib they need", () => {
		const keys = menuView(MENU_ROOT, "ios").rows.map((r) => r.key);
		expect(keys).not.toContain("n");
		expect(keys).not.toContain("t");
		expect(keys).toContain("b");
		expect(menuKey(MENU_ROOT, press("n"), "ios")).toEqual({ kind: "none" });
	});

	test("root lists the areas with their letters and the selection", () => {
		const view = menuView({ area: undefined, index: 2 }, "android");
		expect(view.title).toBe("conditions");
		expect(view.rows.map((r) => r.key)).toEqual(CONDITION_AREAS.map((a) => a.key));
		expect(view.rows.map((r) => r.selected)).toEqual(CONDITION_AREAS.map((_, i) => i === 2));
	});

	test("an area lists its items, titled with the area", () => {
		const view = menuView(inArea("n"), "android");
		expect(view.title).toBe("conditions › network");
		expect(view.rows.find((r) => r.key === "o")?.label).toBe("offline");
	});
});

describe("every preset is a real `warden ui` command", () => {
	afterEach(cleanupHarnesses);

	test("its values pass the verb's own validation on a leased device (a bad one exits 1)", async () => {
		const bad = harness(() => snapshotOf(LOGIN));
		expect(await bad.run("location", "scenario", "bogus")).toBe(1);
		for (const preset of CONDITION_AREAS.flatMap((a) => a.items)) {
			const h = harness(() => snapshotOf(LOGIN));
			const code = await h.run(...preset.argv);
			expect({ argv: preset.argv.join(" "), usage: code === 1, err: h.c.stderr.join("\n") }).toMatchObject({
				usage: false,
			});
		}
	});
});
