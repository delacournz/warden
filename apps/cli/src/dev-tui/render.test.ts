import { describe, expect, test } from "bun:test";
import type { DevReady } from "../commands/dev-ui";
import { stripAnsi, visibleWidth } from "./ansi";
import type { Key } from "./keys";
import { createMetroPane } from "./metro-pane";
import { type HudFps, type HudSample, initialState, type TuiState } from "./model";
import { reduce, type TuiEvent } from "./reducer";
import { formatDuration, HUD_WIDTH, hudLines, listWidth, paneCursor, render } from "./render";

const READY: DevReady = {
	platform: "ios",
	deviceId: "8F2A-1C3D",
	deviceName: "warden-iphone-17-5",
	port: 8101,
	metroUrl: "http://localhost:8101",
	leaseIds: ["l1"],
	app: { source: "cache", hash: "abc123" },
	projectName: "example",
};

const press = (name: string): TuiEvent => ({
	type: "key",
	key: { name, ctrl: false, shift: false, seq: name } satisfies Key,
	at: 0,
});

function stateAt(cols: number, rows: number, events: TuiEvent[]): TuiState {
	return events.reduce(reduce, initialState({ cols, rows }, 0));
}

const threeTasks: TuiEvent[] = [
	{ type: "task:start", id: "claim", title: "claim device", at: 0 },
	{ type: "task:log", id: "claim", line: "ios · warden-iphone-17-5" },
	{ type: "task:ok", id: "claim", detail: "port 8101", at: 1300 },
	{ type: "task:start", id: "app", title: "dev build", at: 1300 },
	{ type: "task:log", id: "app", line: "fingerprint abc123" },
	{
		type: "task:log",
		id: "app",
		line: "a very long line that has to wrap because the log pane is narrower than it: /Users/chris/project/node_modules/.bin/expo",
	},
];

function text(rows: string[]): string {
	return rows.map((row) => stripAnsi(row).trimEnd()).join("\n");
}

function expectExactWidth(rows: string[], cols: number, height: number): void {
	expect(rows).toHaveLength(height);
	for (const row of rows) expect(visibleWidth(row)).toBe(cols);
}

describe("render", () => {
	for (const [cols, rows] of [
		[80, 24],
		[120, 40],
	] as const) {
		test(`three tasks at ${cols}x${rows}`, () => {
			const state = stateAt(cols, rows, threeTasks);
			const frame = render(state, cols, rows);
			expectExactWidth(frame, cols, rows);
			expect(text(frame)).toMatchSnapshot();
		});

		test(`session ready with the header filled at ${cols}x${rows}`, () => {
			const state = stateAt(cols, rows, [...threeTasks, { type: "ready", info: READY, at: 2000 }]);
			const frame = render(state, cols, rows);
			expectExactWidth(frame, cols, rows);
			expect(text(frame)).toMatchSnapshot();
		});

		test(`help overlay at ${cols}x${rows}`, () => {
			const state = stateAt(cols, rows, [...threeTasks, press("?")]);
			const frame = render(state, cols, rows);
			expectExactWidth(frame, cols, rows);
			expect(text(frame)).toMatchSnapshot();
		});
	}

	test("too small shows one line", () => {
		const state = stateAt(50, 12, threeTasks);
		const frame = render(state, 50, 12);
		expectExactWidth(frame, 50, 12);
		expect(text(frame)).toMatchSnapshot();
		expect(frame.slice(1).every((row) => row.trim() === "")).toBe(true);
	});

	test("short but wide is too small too", () => {
		expect(stripAnsi(render(stateAt(120, 15, []), 120, 15)[0] ?? "")).toContain("terminal too small");
	});

	test("the HUD slot shows from 100 columns only", () => {
		const wide = render(stateAt(100, 24, []), 100, 24)[0] ?? "";
		const narrow = render(stateAt(99, 24, []), 99, 24)[0] ?? "";
		expect(stripAnsi(wide)).toContain("hud off");
		expect(stripAnsi(narrow)).not.toContain("hud");
	});

	test("task glyphs and durations", () => {
		const frame = text(render(stateAt(80, 24, threeTasks), 80, 24));
		expect(frame).toContain("✓ claim device");
		expect(frame).toContain("1.3s");
		expect(frame).toContain("▶ dev build");
		expect(frame).toContain("· metro");
	});

	test("the left column is a third of the width, at most 32", () => {
		expect(listWidth(80)).toBe(26);
		expect(listWidth(120)).toBe(32);
	});

	test("the log pane wraps and follows the tail", () => {
		const frame = text(render(stateAt(80, 24, threeTasks), 80, 24));
		expect(frame).toContain("dules/.bin/expo");
		expect(frame).toContain("fingerprint abc123");
	});

	test("scrolled up hides the tail", () => {
		const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
		const base = stateAt(80, 24, [{ type: "task:log", id: "claim", line: lines }]);
		const tail = text(render(base, 80, 24));
		expect(tail).toContain("line 59");
		expect(tail).not.toContain("line 0\n");
		const scrolled = [press("tab"), press("g")].reduce(reduce, base);
		const top = text(render(scrolled, 80, 24));
		expect(top).toContain("line 0");
		expect(top).not.toContain("line 59");
	});

	test("selecting the metro row shows the placeholder then its lines", () => {
		const state = stateAt(80, 24, [
			{ type: "task:log", id: "metro", line: "Starting Metro" },
			press("down"),
			press("down"),
			press("down"),
		]);
		const frame = text(render(state, 80, 24));
		expect(frame).toContain("Metro output appears here");
		expect(frame).toContain("Starting Metro");
	});

	test("footer follows the mode and says stopping once quitting", () => {
		const list =
			text(render(stateAt(80, 24, []), 80, 24))
				.split("\n")
				.at(-1) ?? "";
		expect(list).toContain("q quit");
		const log =
			text(render(stateAt(80, 24, [press("tab")]), 80, 24))
				.split("\n")
				.at(-1) ?? "";
		expect(log).toContain("scroll");
		const quitting =
			text(render(stateAt(80, 24, [press("q")]), 80, 24))
				.split("\n")
				.at(-1) ?? "";
		expect(quitting).toContain("stopping…");
	});

	test("the prompt shows its label and the typed text in the footer", () => {
		const state = stateAt(80, 24, [
			{ type: "prompt:open", label: "mark" },
			{ type: "prompt:edit", edit: { op: "char", char: "s" } },
			{ type: "prompt:edit", edit: { op: "char", char: "x" } },
		]);
		const frame = render(state, 80, 24);
		expectExactWidth(frame, 80, 24);
		const footer = text(frame).split("\n").at(-1) ?? "";
		expect(footer).toContain("mark: sx");
		expect(footer).toContain("esc cancel");
	});

	test("the help overlay lists the action keys", () => {
		const frame = text(render(stateAt(120, 40, [press("?")]), 120, 40));
		for (const desc of [
			"reload app",
			"show sim",
			"screenshot",
			"reinstall app",
			"restart sim",
			"perf mark",
			"perf report",
		])
			expect(frame).toContain(desc);
	});

	test("long text never overflows a row", () => {
		const state = stateAt(60, 16, [
			{ type: "ready", info: { ...READY, metroUrl: `http://${"x".repeat(200)}` }, at: 0 },
			{ type: "task:log", id: "claim", line: "界".repeat(3) + "y".repeat(300) },
		]);
		expectExactWidth(render(state, 60, 16), 60, 16);
	});
});

describe("Metro pane", () => {
	const fixture = Bun.file(`${import.meta.dir}/fixtures/expo-start.bin`).arrayBuffer();
	const toMetro = [press("down"), press("down"), press("down")];

	async function paneAt(cols: number, rows: number) {
		const pane = createMetroPane({ cols: cols - listWidth(cols) - 3, rows: rows - 2 });
		const bytes = new Uint8Array(await fixture);
		for (let i = 0; i < bytes.length; i += 1024) await pane.write(bytes.slice(i, i + 1024));
		return pane;
	}

	test("the selected metro row shows the pane's rows at 120x40", async () => {
		const pane = await paneAt(120, 40);
		const state = stateAt(120, 40, toMetro);
		const frame = render(state, 120, 40, { rows: pane.rows(), cursor: pane.cursor() });
		expectExactWidth(frame, 120, 40);
		const shown = text(frame);
		expect(shown).not.toContain("Metro output appears here");
		expect(shown).toContain("Press w │ open web");
		expect(shown).toMatchSnapshot();
		pane.dispose();
	});

	test("pane colours reach the frame", async () => {
		const pane = await paneAt(120, 40);
		const state = stateAt(120, 40, toMetro);
		const raw = render(state, 120, 40, { rows: pane.rows(), cursor: pane.cursor() }).join("\n");
		expect(raw).toContain(`${String.fromCharCode(27)}[0;`);
		pane.dispose();
	});

	test("an empty pane keeps the placeholder", () => {
		const state = stateAt(80, 24, toMetro);
		const frame = text(render(state, 80, 24, { rows: Array(22).fill(""), cursor: { x: 0, y: 0, visible: true } }));
		expect(frame).toContain("Metro output appears here");
	});

	test("after Metro exits the pane's last rows are followed by the exit note", async () => {
		const pane = await paneAt(80, 24);
		const state = stateAt(80, 24, [...toMetro, { type: "metro:exit", code: 3, at: 9 }]);
		const frame = text(render(state, 80, 24, { rows: pane.rows(), cursor: pane.cursor() }));
		expect(frame).toContain("metro exited (code 3)");
		pane.dispose();
	});

	test("other rows ignore the pane", async () => {
		const pane = await paneAt(80, 24);
		const frame = text(render(stateAt(80, 24, []), 80, 24, { rows: pane.rows(), cursor: pane.cursor() }));
		expect(frame).not.toContain("open web");
		pane.dispose();
	});

	test("the cursor sits at the pane's cursor only while interacting with the metro row", () => {
		const cursor = { x: 4, y: 7, visible: true };
		const interact = stateAt(120, 40, [...toMetro, press("i")]);
		expect(paneCursor(interact, 120, cursor)).toEqual({ x: listWidth(120) + 2 + 4, y: 1 + 7 });
		expect(paneCursor(stateAt(120, 40, toMetro), 120, cursor)).toBeUndefined();
		expect(paneCursor(interact, 120, { ...cursor, visible: false })).toBeUndefined();
		const exited = [...toMetro, press("i"), { type: "metro:exit", code: 0, at: 1 } satisfies TuiEvent];
		expect(paneCursor(stateAt(120, 40, exited), 120, cursor)).toBeUndefined();
	});

	test("the interact footer names the keys", () => {
		const last =
			text(render(stateAt(120, 40, [...toMetro, press("i")]), 120, 40))
				.split("\n")
				.at(-1) ?? "";
		expect(last).toContain("Esc back · keys go to Expo · Shift+PgUp/PgDn scroll");
	});
});

describe("formatDuration", () => {
	test("units", () => {
		expect(formatDuration(412)).toBe("412ms");
		expect(formatDuration(1300)).toBe("1.3s");
		expect(formatDuration(125_000)).toBe("2m05s");
	});
});

describe("HUD", () => {
	const okSample = (over: Partial<Extract<HudSample, { kind: "ok" }>> = {}): HudSample => ({
		kind: "ok",
		cpuPct: 14,
		cpuHistory: [3, 8, 14, 9, 4, 2, 5, 14],
		memKb: 182_000,
		memKind: "rss",
		...over,
	});
	const sample = (s: HudSample, fps?: HudFps): TuiEvent => ({ type: "hud:sample", sample: s, fps, at: 745_000 });
	const base: TuiEvent[] = [...threeTasks, { type: "ready", info: READY, at: 4000 }, press("h")];
	const withBundle = (state: TuiState): TuiState => ({
		...state,
		hud: { ...state.hud, bundle: { ms: 1300, modules: 412 } },
	});

	test("120x40 with the HUD on", () => {
		const state = withBundle(stateAt(120, 40, [...base, sample(okSample())]));
		const frame = render(state, 120, 40);
		expectExactWidth(frame, 120, 40);
		expect(text(frame)).toMatchSnapshot();
	});

	test("120x40 with the HUD off", () => {
		const state = stateAt(120, 40, [...threeTasks, { type: "ready", info: READY, at: 4000 }]);
		const frame = render(state, 120, 40);
		expectExactWidth(frame, 120, 40);
		expect(text(frame)).not.toContain("cpu");
		expect(text(frame)).toMatchSnapshot();
	});

	test("nothing is drawn at 80 columns, on or off", () => {
		const state = stateAt(80, 24, [...base, sample(okSample())]);
		expect(hudLines(state, 80)).toBeUndefined();
		expect(text(render(state, 80, 24))).not.toContain("cpu");
	});

	test("it covers the top right of the pane and leaves the task list alone", () => {
		const state = stateAt(120, 40, [...base, sample(okSample())]);
		const rows = render(state, 120, 40).map(stripAnsi);
		expect(rows[1]?.slice(120 - HUD_WIDTH)).toMatch(/^┌ warden-iphone-17-5 ── 00:12:21 ─*┐$/);
		expect(rows[1]?.slice(0, 32)).toContain("claim device");
	});

	test("iOS shows rss and no fps", () => {
		const lines = (hudLines(stateAt(120, 40, [...base, sample(okSample())]), 120) ?? []).map(stripAnsi);
		expect(lines.join("\n")).toContain("cpu  14% ▂▄▆▄▂▂▃▆  rss 178 MB");
		expect(lines.join("\n")).toContain("fps —  (iOS sim: no frame API)");
	});

	test("Android shows pss, fps and jank", () => {
		const android = stateAt(120, 40, [{ type: "ready", info: { ...READY, platform: "android" }, at: 0 }, press("h")]);
		const done = reduce(android, sample(okSample({ memKind: "pss", memKb: 150_000 }), { fps: 59.4, jankPct: 2.1 }));
		const text = (hudLines(done, 120) ?? []).map(stripAnsi).join("\n");
		expect(text).toContain("pss 146 MB");
		expect(text).toContain("fps 59  jank 2%");
	});

	test("waiting, not running and the metro and perf rows", () => {
		const waiting = (hudLines(stateAt(120, 40, [...threeTasks, press("h")]), 120) ?? []).map(stripAnsi).join("\n");
		expect(waiting).toContain("waiting for the app");
		const gone = reduce(stateAt(120, 40, [...base]), sample({ kind: "not-running" }));
		expect((hudLines(gone, 120) ?? []).map(stripAnsi).join("\n")).toContain("app not running");
		const recording: TuiState = {
			...withBundle(stateAt(120, 40, [...base, sample(okSample())])),
			now: 745_000,
		};
		recording.hud = { ...recording.hud, perf: { startedAt: 726_000, marks: 2 } };
		const rec = (hudLines(recording, 120) ?? []).map(stripAnsi).join("\n");
		expect(rec).toContain("metro bundled 1.3 s · 412 mods");
		expect(rec).toContain("perf ● rec 00:19  marks 2");
	});

	test("every row is exactly the box width", () => {
		for (const line of hudLines(withBundle(stateAt(120, 40, [...base, sample(okSample())])), 120) ?? [])
			expect(visibleWidth(line)).toBe(HUD_WIDTH);
	});
});
