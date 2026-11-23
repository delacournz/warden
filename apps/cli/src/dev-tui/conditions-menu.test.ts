import { describe, expect, test } from "bun:test";
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
		expect(menuKey(MENU_ROOT, press("b"), "ios")).toEqual({ kind: "move", menu: inArea("b") });
	});

	test("arrows move the selection, enter / right open it", () => {
		const down = menuKey(MENU_ROOT, press("down"), "ios");
		expect(down).toEqual({ kind: "move", menu: { area: undefined, index: 1 } });
		const second = CONDITION_AREAS[1]?.key;
		expect(menuKey({ area: undefined, index: 1 }, press("enter"), "ios")).toEqual({
			kind: "move",
			menu: inArea(second ?? ""),
		});
		expect(menuKey({ area: undefined, index: 1 }, press("right"), "ios")).toEqual({
			kind: "move",
			menu: inArea(second ?? ""),
		});
	});

	test("up at the top stays; down at the bottom stays", () => {
		expect(menuKey(MENU_ROOT, press("up"), "ios")).toEqual({ kind: "move", menu: MENU_ROOT });
		const last = CONDITION_AREAS.length - 1;
		expect(menuKey({ area: undefined, index: last }, press("down"), "ios")).toEqual({
			kind: "move",
			menu: { area: undefined, index: last },
		});
	});

	test("esc, q and C close it", () => {
		for (const name of ["escape", "q", "C"]) expect(menuKey(MENU_ROOT, press(name), "ios")).toEqual({ kind: "close" });
	});

	test("an unknown key does nothing", () => {
		expect(menuKey(MENU_ROOT, press("Z"), "ios")).toEqual({ kind: "none" });
	});
});

describe("menuKey: inside an area", () => {
	test("an item letter runs it", () => {
		const step = menuKey(inArea("b"), press("m"), "ios");
		expect(step.kind === "run" && step.item.argv).toEqual(["biometrics", "match"]);
		expect(step.kind === "run" && step.area.label).toBe("biometrics");
	});

	test("enter runs the selected item", () => {
		const bio = menuView(inArea("b"), "ios");
		const second = bio.rows[1];
		const step = menuKey(inArea("b", 1), press("enter"), "ios");
		expect(step.kind === "run" && step.item.label).toBe(second?.label ?? "");
	});

	test("esc / left / backspace go back to the areas, keeping the area selected", () => {
		const index = CONDITION_AREAS.findIndex((a) => a.key === "n");
		for (const name of ["escape", "left", "backspace"])
			expect(menuKey(inArea("n"), press(name), "ios")).toEqual({ kind: "move", menu: { area: undefined, index } });
	});

	test("q closes from inside an area", () => {
		expect(menuKey(inArea("n"), press("q"), "ios")).toEqual({ kind: "close" });
	});

	test("an item for another platform is hidden and its letter does nothing", () => {
		expect(menuKey(inArea("b"), press("e"), "android")).toEqual({ kind: "none" });
		expect(menuView(inArea("b"), "android").rows.map((r) => r.label)).not.toContain("enroll");
	});

	test("ctrl keys are never shortcuts", () => {
		expect(menuKey(inArea("b"), press("m", { ctrl: true }), "ios")).toEqual({ kind: "none" });
	});
});

describe("menuView", () => {
	test("root lists the areas with their letters and the selection", () => {
		const view = menuView({ area: undefined, index: 2 }, "ios");
		expect(view.title).toBe("conditions");
		expect(view.rows.map((r) => r.key)).toEqual(CONDITION_AREAS.map((a) => a.key));
		expect(view.rows.map((r) => r.selected)).toEqual(CONDITION_AREAS.map((_, i) => i === 2));
	});

	test("an area lists its items, titled with the area", () => {
		const view = menuView(inArea("n"), "ios");
		expect(view.title).toBe("conditions › network");
		expect(view.rows.find((r) => r.key === "o")?.label).toBe("offline");
	});
});

describe("every preset is a real `warden ui` command", () => {
	test("parses (exit 2 on the unleased device, never a usage error)", async () => {
		const [{ uiCommand }, { testContext }, { OWNER_ENV }] = await Promise.all([
			import("../commands/ui"),
			import("../testing"),
			import("../simctl.testing"),
		]);
		for (const preset of CONDITION_AREAS.flatMap((a) => a.items)) {
			const c = testContext([...preset.argv, "--udid", "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D", "--force"]);
			c.env = { ...c.env, ...OWNER_ENV };
			const code = await uiCommand.run(c);
			expect({ argv: preset.argv.join(" "), code, err: c.stderr.join("\n") }).toMatchObject({ code: 2 });
			c.cleanup();
		}
	});
});
