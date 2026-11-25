import { describe, expect, test } from "bun:test";
import type { DevReady } from "../commands/dev-ui";
import type { MenuItem } from "./conditions-menu";
import { createKeyRouter } from "./key-router";
import type { Key } from "./keys";
import { initialState, type TuiState } from "./model";
import { reduce, type TuiEvent } from "./reducer";

const press = (name: string, flags: { ctrl?: boolean; shift?: boolean } = {}): Key => ({
	name,
	ctrl: flags.ctrl ?? false,
	shift: flags.shift ?? false,
	seq: name,
});

const READY: DevReady = {
	platform: "ios",
	deviceId: "UDID-1",
	deviceName: "iPhone",
	port: 8101,
	metroUrl: "http://127.0.0.1:8101",
	leaseIds: ["l1"],
	app: undefined,
	projectName: "example",
};

function setup(ready: DevReady | undefined = READY) {
	let state: TuiState = initialState({ cols: 100, rows: 30 }, 0);
	if (ready) state = reduce(state, { type: "ready", info: ready, at: 0 });
	const ran: Array<{ area: string; argv: readonly string[] }> = [];
	const actions: string[] = [];
	const dispatch = (event: TuiEvent): void => {
		state = reduce(state, event);
	};
	const route = createKeyRouter({
		state: () => state,
		now: () => 0,
		dispatch,
		schedule: () => undefined,
		metroTerminal: () => undefined,
		pane: { scroll: () => undefined, scrollToBottom: () => undefined },
		paneRows: () => 10,
		run: (action) => actions.push(action),
		submitPrompt: () => undefined,
		runCondition: (item: MenuItem, area) => ran.push({ area: area.label, argv: item.argv }),
	});
	return { route, ran, actions, state: () => state };
}

describe("key router: conditions menu", () => {
	test("C, b, m runs `biometrics match` and keeps the menu open in that area", () => {
		const h = setup();
		h.route(press("C", { shift: true }));
		h.route(press("b"));
		h.route(press("m"));
		expect(h.ran).toEqual([{ area: "biometrics", argv: ["biometrics", "match"] }]);
		expect(h.state().mode).toBe("menu");
		expect(h.state().menu).toEqual({ area: "b", index: 0 });
	});

	test("menu letters never reach the list actions (m is perf mark in list mode)", () => {
		const h = setup();
		h.route(press("C", { shift: true }));
		h.route(press("b"));
		h.route(press("m"));
		expect(h.actions).toEqual([]);
	});

	test("arrows + enter walk to a preset", () => {
		const h = setup({ ...READY, platform: "android", deviceId: "emulator-5554" });
		h.route(press("C", { shift: true }));
		h.route(press("down"));
		h.route(press("enter"));
		expect(h.state().menu?.area).toBe("n");
		h.route(press("enter"));
		expect(h.ran[0]?.argv).toEqual(["network", "set", "offline"]);
	});

	test("esc backs out an area, then closes the menu", () => {
		const h = setup({ ...READY, platform: "android", deviceId: "emulator-5554" });
		h.route(press("C", { shift: true }));
		h.route(press("n"));
		h.route(press("escape"));
		expect(h.state().menu).toEqual({ area: undefined, index: 1 });
		h.route(press("escape"));
		expect(h.state().mode).toBe("list");
		expect(h.state().menu).toBeUndefined();
	});

	test("Ctrl-C in the menu still quits", () => {
		const h = setup();
		h.route(press("C", { shift: true }));
		h.route(press("c", { ctrl: true }));
		expect(h.state().quitting).toBe(true);
	});

	test("an Android session cannot pick an iOS-only preset", () => {
		const h = setup({ ...READY, platform: "android", deviceId: "emulator-5554" });
		h.route(press("C", { shift: true }));
		h.route(press("b"));
		h.route(press("e"));
		expect(h.ran).toEqual([]);
	});
});
