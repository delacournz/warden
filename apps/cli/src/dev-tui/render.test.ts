import { describe, expect, test } from "bun:test";
import type { DevReady } from "../commands/dev-ui";
import { stripAnsi, visibleWidth } from "./ansi";
import type { Key } from "./keys";
import { initialState, type TuiState } from "./model";
import { reduce, type TuiEvent } from "./reducer";
import { formatDuration, listWidth, render } from "./render";

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

	test("long text never overflows a row", () => {
		const state = stateAt(60, 16, [
			{ type: "ready", info: { ...READY, metroUrl: `http://${"x".repeat(200)}` }, at: 0 },
			{ type: "task:log", id: "claim", line: "界".repeat(3) + "y".repeat(300) },
		]);
		expectExactWidth(render(state, 60, 16), 60, 16);
	});
});

describe("formatDuration", () => {
	test("units", () => {
		expect(formatDuration(412)).toBe("412ms");
		expect(formatDuration(1300)).toBe("1.3s");
		expect(formatDuration(125_000)).toBe("2m05s");
	});
});
