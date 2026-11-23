import type { Platform } from "@delacour/warden-core/types";
import type { Key } from "./keys";

/** One preset: a `warden ui` verb and its args (the device flags are added when it runs). */
export type MenuItem = {
	key: string;
	label: string;
	argv: readonly string[];
	/** only on these platforms (default: both) */
	platforms?: readonly Platform[];
};

export type MenuArea = { key: string; label: string; items: readonly MenuItem[] };

/** Where the menu is: the areas (`area` undefined) or one area's presets; `index` is the selected row. */
export type MenuState = { area: string | undefined; index: number };

/** What a key does in the menu: move (or open an area), close it, run a preset, or nothing. */
export type MenuStep =
	| { kind: "move"; menu: MenuState }
	| { kind: "close" }
	| { kind: "run"; item: MenuItem; area: MenuArea }
	| { kind: "none" };

export const MENU_ROOT: MenuState = { area: undefined, index: 0 };

const item = (key: string, label: string, argv: readonly string[], platforms?: readonly Platform[]): MenuItem => ({
	key,
	label,
	argv,
	...(platforms ? { platforms } : {}),
});

const status = (verb: readonly string[]): MenuItem => item("?", "status", [...verb, "status"]);

/**
 * The presets `C` offers, grouped by area. Each runs `warden ui <argv> --udid <session device>`: the same verb, lease
 * check and release-time undo as typing it. No free-text values (lat/lon, ISO time, locale): type those with `warden ui`.
 */
export const CONDITION_AREAS: readonly MenuArea[] = [
	{
		key: "b",
		label: "biometrics",
		items: [
			item("e", "enroll", ["biometrics", "enroll"], ["ios"]),
			item("m", "match", ["biometrics", "match"]),
			item("f", "fail", ["biometrics", "fail"]),
			item("u", "unenroll", ["biometrics", "unenroll"], ["ios"]),
			item("r", "reenroll", ["biometrics", "reenroll"], ["ios"]),
			item("?", "status", ["biometrics", "status"]),
		],
	},
	{
		key: "n",
		label: "network",
		items: [
			item("o", "offline", ["network", "set", "offline"]),
			item("e", "edge", ["network", "set", "edge"]),
			item("3", "3g", ["network", "set", "3g"]),
			item("l", "lte", ["network", "set", "lte"]),
			item("s", "slow", ["network", "set", "slow"]),
			item("x", "lossy", ["network", "set", "lossy"]),
			item("f", "flap (10s up, 3s down)", ["network", "flap", "--up", "10s", "--down", "3s"]),
			item("r", "reset (online)", ["network", "reset"]),
			status(["network"]),
		],
	},
	{
		key: "l",
		label: "location",
		items: [
			item("r", "city run", ["location", "scenario", "city-run"]),
			item("b", "city bike", ["location", "scenario", "city-bike"]),
			item("f", "freeway", ["location", "scenario", "freeway"]),
			item("x", "clear", ["location", "clear"]),
			status(["location"]),
		],
	},
	{
		key: "t",
		label: "clock",
		items: [
			item("h", "+1 hour", ["clock", "advance", "1h"]),
			item("d", "+1 day", ["clock", "advance", "1d"]),
			item("w", "+1 week", ["clock", "advance", "7d"]),
			item("m", "+30 days", ["clock", "advance", "30d"]),
			item("r", "reset (real time)", ["clock", "reset"]),
			status(["clock"]),
		],
	},
	{
		key: "a",
		label: "appearance",
		items: [item("d", "dark", ["screen", "appearance", "dark"]), item("l", "light", ["screen", "appearance", "light"])],
	},
	{
		key: "k",
		label: "keyboard",
		items: [
			item("s", "software (on screen)", ["keyboard", "software"]),
			item("h", "hardware (hidden)", ["keyboard", "hardware"]),
			item("t", "toggle", ["keyboard", "toggle"]),
			status(["keyboard"]),
		],
	},
	{
		key: "y",
		label: "accessibility",
		items: [
			item("t", "large text", ["a11y", "set", "--text-size", "accessibility-large"]),
			item("b", "bold text", ["a11y", "set", "--bold"]),
			item("c", "increased contrast", ["a11y", "set", "--contrast", "increased"]),
			item("m", "reduce motion", ["a11y", "set", "--reduce-motion"]),
			item("r", "reset", ["a11y", "reset"]),
			status(["a11y"]),
		],
	},
	{
		key: "p",
		label: "battery",
		items: [
			item("l", "low (10%, unplugged)", ["battery", "set", "--level", "10", "--no-charging"]),
			item("c", "charging", ["battery", "set", "--charging"]),
			item("r", "reset", ["battery", "reset"]),
			status(["battery"]),
		],
	},
];

const onPlatform =
	(platform: Platform) =>
	(i: MenuItem): boolean =>
		i.platforms === undefined || i.platforms.includes(platform);

function areaOf(menu: MenuState): MenuArea | undefined {
	return menu.area === undefined ? undefined : CONDITION_AREAS.find((a) => a.key === menu.area);
}

function itemsOf(area: MenuArea, platform: Platform): MenuItem[] {
	return area.items.filter(onPlatform(platform));
}

const clamp = (index: number, count: number): number => Math.max(0, Math.min(count - 1, index));

const move = (menu: MenuState, delta: number, count: number): MenuStep => ({
	kind: "move",
	menu: { ...menu, index: clamp(menu.index + delta, count) },
});

const open = (area: MenuArea): MenuStep => ({ kind: "move", menu: { area: area.key, index: 0 } });

function rootKey(menu: MenuState, key: Key): MenuStep {
	if (key.name === "escape" || key.name === "q" || key.name === "C") return { kind: "close" };
	if (key.name === "up" || key.name === "down") return move(menu, key.name === "up" ? -1 : 1, CONDITION_AREAS.length);
	if (key.name === "enter" || key.name === "right") {
		const selected = CONDITION_AREAS[menu.index];
		return selected ? open(selected) : { kind: "none" };
	}
	const area = CONDITION_AREAS.find((a) => a.key === key.name);
	return area ? open(area) : { kind: "none" };
}

function areaKey(menu: MenuState, area: MenuArea, key: Key, platform: Platform): MenuStep {
	if (key.name === "q" || key.name === "C") return { kind: "close" };
	if (key.name === "escape" || key.name === "left" || key.name === "backspace")
		return { kind: "move", menu: { area: undefined, index: CONDITION_AREAS.indexOf(area) } };
	const items = itemsOf(area, platform);
	if (key.name === "up" || key.name === "down") return move(menu, key.name === "up" ? -1 : 1, items.length);
	const chosen = key.name === "enter" ? items[menu.index] : items.find((i) => i.key === key.name);
	return chosen ? { kind: "run", item: chosen, area } : { kind: "none" };
}

/** Pure: what `key` does in the menu at `menu` on `platform`. Ctrl keys are never shortcuts. */
export function menuKey(menu: MenuState, key: Key, platform: Platform): MenuStep {
	if (key.ctrl) return { kind: "none" };
	const area = areaOf(menu);
	return area ? areaKey(menu, area, key, platform) : rootKey(menu, key);
}

export type MenuRow = { key: string; label: string; selected: boolean; hint?: string };

/** Pure: the menu box's title and rows (the areas, or the open area's presets for `platform`). */
export function menuView(menu: MenuState, platform: Platform): { title: string; rows: MenuRow[] } {
	const area = areaOf(menu);
	if (area === undefined) {
		return {
			title: "conditions",
			rows: CONDITION_AREAS.map((a, i) => ({
				key: a.key,
				label: a.label,
				selected: i === menu.index,
				hint: itemsOf(a, platform)
					.filter((x) => x.key !== "?")
					.map((x) => x.label.split(" (")[0])
					.join(" · "),
			})),
		};
	}
	return {
		title: `conditions › ${area.label}`,
		rows: itemsOf(area, platform).map((x, i) => ({ key: x.key, label: x.label, selected: i === menu.index })),
	};
}
