import { describe, expect, test } from "bun:test";
import type { DevReady } from "../commands/dev-ui";
import type { Key } from "./keys";
import { initialState, type TuiState } from "./model";
import { MAX_LOG_LINES, reduce, type TuiEvent } from "./reducer";

const press = (name: string, flags: Partial<Key> = {}): TuiEvent => ({
	type: "key",
	key: { name, ctrl: false, shift: false, seq: name, ...flags },
	at: 1000,
});

const READY: DevReady = {
	platform: "ios",
	deviceId: "UDID-1",
	deviceName: "iPhone 17",
	port: 8101,
	metroUrl: "http://localhost:8101",
	leaseIds: ["l1"],
	app: { source: "cache", hash: "abc123" },
	projectName: "example",
};

const fresh = (): TuiState => initialState({ cols: 80, rows: 24 }, 0);
const run = (events: TuiEvent[], from = fresh()): TuiState => events.reduce(reduce, from);
const task = (state: TuiState, id: string) => state.tasks.find((t) => t.id === id);

describe("tasks", () => {
	test("start, log, ok records status, times and lines", () => {
		const state = run([
			{ type: "task:start", id: "claim", title: "claiming ios", at: 100 },
			{ type: "task:log", id: "claim", line: "port 8101" },
			{ type: "task:ok", id: "claim", detail: "UDID-1", at: 350 },
		]);
		expect(task(state, "claim")).toMatchObject({
			title: "claiming ios",
			status: "ok",
			startedAt: 100,
			endedAt: 350,
			log: ["port 8101", "UDID-1"],
		});
	});

	test("fail appends the error", () => {
		const state = run([
			{ type: "task:start", id: "app", title: "build", at: 0 },
			{ type: "task:fail", id: "app", error: "boom", at: 5 },
		]);
		expect(task(state, "app")).toMatchObject({ status: "fail", log: ["boom"] });
	});

	test("multi-line text splits into lines and control bytes are dropped", () => {
		const state = run([{ type: "task:log", id: "metro", line: "a\r\nb\x1b[2Jc\n" }]);
		expect(task(state, "metro")?.log).toEqual(["a", "bc"]);
	});

	test("an unknown id adds a row (action rows later)", () => {
		const state = run([{ type: "task:start", id: "screenshot", title: "screenshot", at: 0 }]);
		expect(state.tasks.at(-1)).toMatchObject({ id: "screenshot", status: "running" });
	});

	test("log is capped", () => {
		const lines = Array.from({ length: MAX_LOG_LINES + 10 }, (_, i) => `l${i}`).join("\n");
		const state = run([{ type: "task:log", id: "metro", line: lines }]);
		expect(task(state, "metro")?.log).toHaveLength(MAX_LOG_LINES);
		expect(task(state, "metro")?.log.at(-1)).toBe(`l${MAX_LOG_LINES + 9}`);
	});

	test("selection follows the newest started task until the person moves it", () => {
		let state = run([{ type: "task:start", id: "app", title: "build", at: 0 }]);
		expect(state.tasks[state.selected]?.id).toBe("app");
		state = run([press("up"), { type: "task:start", id: "metro", title: "metro", at: 1 }], state);
		expect(state.tasks[state.selected]?.id).toBe("show");
	});
});

describe("keys", () => {
	test("select clamps at both ends", () => {
		let state = run([press("up")]);
		expect(state.selected).toBe(0);
		state = run(Array.from({ length: 20 }, () => press("down")));
		expect(state.selected).toBe(state.tasks.length - 1);
	});

	test("tab focuses the log; scroll moves it, bottom follows the tail again", () => {
		let state = run([{ type: "task:log", id: "claim", line: "1\n2\n3\n4\n5" }, press("tab")]);
		expect(state.mode).toBe("log");
		state = run([press("up"), press("up")], state);
		expect(task(state, "claim")?.scroll).toBe(2);
		state = run([press("G", { shift: true })], state);
		expect(task(state, "claim")?.scroll).toBe(0);
		state = run([press("g")], state);
		expect(task(state, "claim")?.scroll).toBe(4);
		state = run([press("tab")], state);
		expect(state.mode).toBe("list");
	});

	test("new lines keep a scrolled view in place", () => {
		let state = run([{ type: "task:log", id: "claim", line: "1\n2\n3" }, press("tab"), press("up")]);
		state = run([{ type: "task:log", id: "claim", line: "4" }], state);
		expect(task(state, "claim")?.scroll).toBe(2);
	});

	test("an unbuilt action logs 'not available yet' on the selected row", () => {
		const state = run([press("r")]);
		expect(task(state, "claim")?.log).toEqual(["reload app: not available yet"]);
	});

	test("? opens help, Esc closes it", () => {
		let state = run([press("?")]);
		expect(state.mode).toBe("help");
		state = run([press("escape")], state);
		expect(state.mode).toBe("list");
	});

	test("h toggles the HUD flag; Ctrl-L bumps redraw", () => {
		const state = run([press("h"), press("l", { ctrl: true })]);
		expect(state.hud).toBe(true);
		expect(state.redraw).toBe(1);
	});

	test("q sets quitting once and shows stopping… in the session row", () => {
		let state = run([{ type: "ready", info: READY, at: 10 }, press("q")]);
		expect(state.quitting).toBe(true);
		expect(task(state, "session")).toMatchObject({ title: "stopping…", status: "running" });
		const logLength = task(state, "session")?.log.length;
		state = run([press("q")], state);
		expect(task(state, "session")?.log).toHaveLength(logLength ?? -1);
	});

	test("an unknown key changes nothing but the clock", () => {
		const before = fresh();
		const after = run([press("z")], before);
		expect({ ...after, now: 0 }).toEqual(before);
	});
});

describe("session", () => {
	test("ready stores the info and starts the session row with hints", () => {
		const state = run([{ type: "ready", info: READY, at: 50 }]);
		expect(state.ready).toEqual(READY);
		expect(task(state, "session")?.status).toBe("running");
		const log = task(state, "session")?.log.join("\n") ?? "";
		expect(log).toContain("iPhone 17 (UDID-1)");
		expect(log).toContain("http://localhost:8101");
		expect(log).toContain("cache abc123");
		expect(log).toContain("q or ctrl-c");
	});

	test("resize stores the size", () => {
		expect(run([{ type: "resize", size: { cols: 100, rows: 30 } }]).size).toEqual({ cols: 100, rows: 30 });
	});

	test("metro:exit notes the code on the metro row", () => {
		const state = run([{ type: "metro:exit", code: 2, at: 9 }]);
		expect(state.metroExit).toBe(2);
		expect(task(state, "metro")?.log).toEqual(["metro exited (code 2)"]);
	});
});
