import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeFrames, deadlineFor, jankFinding } from "./analyze";
import { parseGfxinfo } from "./gfxinfo";

const fx = (name: string) => readFileSync(join(import.meta.dir, "..", "..", "fixtures", name), "utf8");

describe("parseGfxinfo", () => {
	test("reads the summary, uptime and PROFILEDATA, skipping Flags != 0 rows", () => {
		const info = parseGfxinfo(fx("gfxinfo-60hz.txt"));
		expect(info?.uptimeMs).toBe(3_600_000);
		expect(info?.summary).toMatchObject({ totalFrames: 520, jankyFrames: 41, jankyPct: 7.88 });
		expect(info?.summary?.percentilesMs.p50).toBeGreaterThan(0);
		expect(info?.frames).toHaveLength(119);
	});

	test("no process: undefined", () => {
		expect(parseGfxinfo(fx("gfxinfo-no-process.txt"))).toBeUndefined();
	});

	test("summary without a table still parses", () => {
		const info = parseGfxinfo("Total frames rendered: 10\nJanky frames: 1 (10.00%)\n");
		expect(info?.frames).toEqual([]);
		expect(info?.summary?.jankyPct).toBe(10);
	});
});

describe("analyzeFrames", () => {
	for (const hz of [60, 90, 120] as const) {
		test(`${hz}Hz: deadline and refresh rate come from the median vsync gap`, () => {
			const info = parseGfxinfo(fx(`gfxinfo-${hz}hz.txt`));
			if (!info) throw new Error("parse");
			const r = analyzeFrames(info);
			expect(r.refreshHz).toBe(hz);
			expect(r.deadlineMs).toBeCloseTo(1000 / hz, 1);
			expect(r.fps).toBeLessThanOrEqual(hz);
			expect(r.fps).toBeGreaterThan(hz / 2);
		});
	}

	test("frozen frame, dropped frames and clusters split on >500ms gaps", () => {
		const info = parseGfxinfo(fx("gfxinfo-60hz.txt"));
		if (!info) throw new Error("parse");
		const r = analyzeFrames(info);
		expect(r.frozenFrames).toBe(1);
		expect(r.worstFrameMs).toBeGreaterThan(800);
		expect(r.droppedFrames).toBeGreaterThan(r.frozenFrames);
		expect(r.jankPct).toBe(7.88);
		expect(r.worstWindows.length).toBeLessThanOrEqual(3);
		const counts = r.worstWindows.map((w) => w.missedDeadlineFrameCount);
		expect(counts).toEqual([...counts].sort((a, b) => b - a));
	});

	test("offsets align to the session via the device uptime; marks tag windows", () => {
		const info = parseGfxinfo(fx("gfxinfo-60hz.txt"));
		if (!info) throw new Error("parse");
		const plain = analyzeFrames(info);
		const aligned = analyzeFrames(info, {
			readAtSessionMs: 10_000,
			marks: [
				{ label: "start", atMs: 0 },
				{ label: "scroll", atMs: 8_000 },
			],
		});
		const w = aligned.worstWindows[0];
		expect(w?.startOffsetMs).toBeGreaterThan(5_000);
		expect(w?.startOffsetMs).toBeLessThan(10_000);
		expect(w?.mark).toBe(w && w.startOffsetMs >= 8_000 ? "scroll" : "start");
		expect(plain.worstWindows[0]?.mark).toBeUndefined();
	});

	test("deadline falls back to 60Hz with <2 frames and clamps", () => {
		expect(deadlineFor([])).toBeCloseTo(16.67, 1);
		expect(deadlineFor([0, 1e6])).toBe(4);
		expect(deadlineFor([0, 200e6])).toBe(50);
	});

	test("an empty sample reports zeros", () => {
		const r = analyzeFrames({ frames: [] });
		expect(r).toMatchObject({ sampledFrames: 0, fps: 0, jankPct: 0, worstWindows: [] });
	});
});

describe("jankFinding", () => {
	test("healthy frames: none", () => {
		expect(jankFinding(analyzeFrames({ frames: [] }))).toBeUndefined();
	});

	test("warn on 7.88% jank with a frozen frame, evidence names the worst window", () => {
		const info = parseGfxinfo(fx("gfxinfo-90hz.txt"));
		if (!info) throw new Error("parse");
		const f = jankFinding(analyzeFrames(info));
		expect(f).toMatchObject({ kind: "jank", severity: "warn", jankPct: 7.88 });
		expect(f?.evidence).toContain("90Hz");
		expect(f?.evidence).toContain("worst window");
	});
});
