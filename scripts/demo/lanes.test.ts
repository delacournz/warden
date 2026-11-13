import { describe, expect, test } from "bun:test";
import type { DevTake, LanesCaption } from "./demo.types";
import { alignLanes, buildLanesFiltergraph, captionSpansLanes, lanesLayout } from "./lanes";

const take = (startedAtS: number, o: Partial<DevTake> = {}): DevTake => ({
	name: "x",
	udid: "u",
	startedAtS,
	beats: [{ id: "client", startS: 5, readyS: 9, endS: 9.5 }],
	recordedS: 20,
	videoStartS: 3,
	exitS: 19,
	released: true,
	...o,
});

describe("lanesLayout", () => {
	const layout = lanesLayout(2, 10);
	test("is 1920x1080 for two lanes", () => {
		expect([layout.width, layout.height]).toEqual([1920, 1080]);
	});
	test("stacks the TUI cards left, puts the phones side by side right, shell strip below", () => {
		expect(layout.rows).toHaveLength(2);
		const [a, b] = layout.rows;
		if (!a || !b) throw new Error("rows");
		expect(a.card.x).toBe(b.card.x);
		expect(b.card.y).toBeGreaterThan(a.card.y + a.card.h);
		expect(a.phone.x).toBeGreaterThan(a.card.x + a.card.w);
		expect(b.phone.x).toBeGreaterThan(a.phone.x + a.phone.w);
		expect(b.phone.y).toBe(a.phone.y);
		expect(layout.shell.card.y).toBeGreaterThan(b.card.y + b.card.h);
		expect(layout.shell.card.y).toBeGreaterThan(a.phone.y + a.phone.h);
	});
	test("everything sits inside an even-sized canvas", () => {
		expect(layout.width % 2).toBe(0);
		expect(layout.height % 2).toBe(0);
		for (const r of layout.rows) {
			expect(r.phone.x + r.phone.w).toBeLessThanOrEqual(layout.width);
			expect(r.phone.w % 2).toBe(0);
		}
		expect(layout.shell.card.y + layout.shell.card.h).toBeLessThan(layout.footerY);
		expect(layout.footerY).toBeLessThan(layout.height);
	});
	test("the shell box keeps the gif's aspect inside its card", () => {
		const { box, card } = layout.shell;
		expect(box.w / box.h).toBeCloseTo(10, 1);
		expect(box.x).toBeGreaterThanOrEqual(card.x);
		expect(box.y + box.h).toBeLessThanOrEqual(card.y + card.h);
	});
});

describe("alignLanes", () => {
	const aligned = alignLanes([take(100), take(103, { videoStartS: 4 })], { startedAtS: 112, durationS: 6 });
	test("puts every take on the clock of the earliest one", () => {
		expect(aligned.lanes.map((l) => l.tuiOffS)).toEqual([0, 3]);
		expect(aligned.lanes.map((l) => l.phoneOffS)).toEqual([3, 7]);
		expect(aligned.shellOffS).toBe(12);
	});
	test("meets when every lane reached the beat, and runs to the last clip's end", () => {
		expect(aligned.meetS).toBeCloseTo(3 + 9, 6);
		expect(aligned.totalS).toBeCloseTo(23, 6);
	});
});

describe("captionSpansLanes", () => {
	const captions: LanesCaption[] = [
		{ text: "one", at: "start" },
		{ text: "two", at: "meet" },
		{ text: "three", at: "shell" },
	];
	test("each caption runs until the next; the last until the end", () => {
		expect(captionSpansLanes(captions, { meetS: 12, shellOffS: 14, totalS: 30 })).toEqual([
			{ text: "one", fromS: 0, toS: 12 },
			{ text: "two", fromS: 12, toS: 14 },
			{ text: "three", fromS: 14, toS: null },
		]);
	});
});

describe("buildLanesFiltergraph", () => {
	const layout = lanesLayout(2, 10);
	const aligned = alignLanes([take(100), take(103)], { startedAtS: 112, durationS: 6 });
	const fg = buildLanesFiltergraph({
		layout,
		aligned,
		tuiBoxes: layout.rows.map((r) => r.tui),
		captions: [{ text: "hello", fromS: 0, toS: null }],
		hold: 1.5,
		monoFont: "/f.ttf",
		workDir: "/w",
	});
	test("pads each source by its offset on the shared clock", () => {
		expect(fg.graph).toContain("tpad=start_duration=3:start_mode=add:color=black");
		expect(fg.graph).toContain("tpad=start_duration=6:start_mode=add:color=black");
		expect(fg.graph).toContain("tpad=start_duration=3:start_mode=add:color=0x171715");
		expect(fg.graph).toContain("tpad=start_duration=12:start_mode=add:color=0x171715");
	});
	test("overlays both phones, both TUIs and the shell at their layout spots", () => {
		for (const r of layout.rows) {
			expect(fg.graph).toContain(`overlay=${r.phone.x}:${r.phone.y}`);
			expect(fg.graph).toContain(`overlay=${r.tui.x}:${r.tui.y}`);
		}
		expect(fg.graph).toContain(`overlay=${layout.shell.box.x}:${layout.shell.box.y}`);
		expect(fg.graph.trimEnd().endsWith("[out]")).toBe(true);
	});
	test("draws the caption to a text file", () => {
		expect(fg.texts[0]?.text).toBe("hello");
	});
});
