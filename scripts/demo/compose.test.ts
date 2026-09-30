import { describe, expect, test } from "bun:test";
import type { Batch } from "./batch";
import { buildFiltergraph, buildTimeline, mp4Args, nextCrf, parseCli, posterArgs, webmArgs } from "./compose";
import { computeLayout } from "./layout";

const T0 = 1_700_000_000_000;
const s = (sec: number) => T0 + sec * 1000;

const batch: Batch = {
	batchId: "b",
	startedAt: s(-10),
	endedAt: s(70),
	ok: true,
	devices: [
		{ worker: "0", udid: "A", name: "iPhone 17", video: "dev-0.mp4", videoStartedAt: s(0) },
		{ worker: "1", udid: "B", name: "iPhone 17", video: "dev-1.mp4", videoStartedAt: s(2) },
	],
	jobs: [
		{ job: "qa-a", worker: "0", udid: "A", seq: 0, attempt: 0, startedAt: s(5), endedAt: s(20), exitCode: 0 },
		{ job: "qa-b", worker: "1", udid: "B", seq: 0, attempt: 0, startedAt: s(5), endedAt: s(30), exitCode: 1 },
		{ job: "qa-b", worker: "1", udid: "B", seq: 1, attempt: 1, startedAt: s(31), endedAt: s(59), exitCode: 0 },
		{ job: "qa-c", worker: "0", udid: "A", seq: 1, attempt: 0, startedAt: s(21), endedAt: s(40), exitCode: 0 },
	],
};

describe("buildTimeline", () => {
	// Real span: first frame (s0) to last job end (s59) + 1s tail = 60s; 60s → 45 - 3 = 42s out.
	const tl = buildTimeline(batch, { duration: 45, hold: 3 });

	test("spans first recording frame to last job end plus a tail, ramped to duration - hold", () => {
		expect(tl.realDuration).toBe(60);
		expect(tl.speed).toBeCloseTo(0.7, 6);
		expect(tl.outDuration).toBeCloseTo(42, 6);
		expect(tl.total).toBe(3);
	});

	test("phone offsets are real seconds from the earliest recording", () => {
		expect(tl.phones.map((p) => p.offset)).toEqual([0, 2]);
	});

	test("cast offset is batch start relative to the first frame (may be negative)", () => {
		expect(tl.castOffset).toBe(-10);
	});

	test("labels: running flow, then ✓/✗ until the worker's next attempt; last one never ends", () => {
		const w1 = tl.labels.filter((l) => l.worker === "1");
		expect(w1.map((l) => [l.text, l.tone])).toEqual([
			["qa-b", "ink"],
			["✗ qa-b", "fail"],
			["qa-b (retry)", "ink"],
			["✓ qa-b", "lease"],
		]);
		expect(w1[0]?.from).toBeCloseTo(3.5, 6);
		expect(w1[1]?.to).toBeCloseTo(31 * 0.7, 6);
		expect(w1[3]?.to).toBeNull();
	});

	test("counter steps at each first pass, turning lease-green when all passed", () => {
		expect(tl.counter.map((c) => [c.text, c.tone])).toEqual([
			["0/3 passed", "ink"],
			["1/3 passed", "ink"],
			["2/3 passed", "ink"],
			["3/3 passed", "lease"],
		]);
		expect(tl.counter[1]?.from).toBeCloseTo(14, 6);
		expect(tl.counter[3]?.to).toBeNull();
	});

	test("never slows a short run down", () => {
		expect(buildTimeline(batch, { duration: 600, hold: 3 }).speed).toBe(1);
	});
});

describe("buildFiltergraph", () => {
	const tl = buildTimeline(batch, { duration: 45, hold: 3 });
	const layout = computeLayout({ width: 1920, phones: 2, phoneAspect: 0.46, terminalAspect: 4 });
	const fg = buildFiltergraph(tl, {
		layout,
		font: "/fonts/Menlo.ttc",
		fps: 30,
		workDir: "/w",
		videos: ["/r/dev-0.mp4", "/r/dev-1.mp4"],
		gif: "/w/tui.gif",
		output: "/w/inter.mp4",
	});

	test("inputs: underlay, one per phone, terminal gif, top layer", () => {
		const inputs = fg.args.flatMap((a, i) => (a === "-i" ? [fg.args[i + 1]] : []));
		expect(inputs).toEqual(["/w/underlay.png", "/r/dev-0.mp4", "/r/dev-1.mp4", "/w/tui.gif", "/w/top.png"]);
		expect(fg.args).toContain("-/filter_complex");
		expect(fg.args.slice(-1)).toEqual(["/w/inter.mp4"]);
	});

	test("each phone is scaled, aligned by tpad, trimmed to the run and ramped", () => {
		const p = layout.phones[1];
		if (!p) throw new Error("no phone");
		expect(fg.graph).toContain(
			`[2:v]scale=${p.screen.w}:${p.screen.h}:flags=lanczos,setsar=1,setpts=PTS-STARTPTS,fps=30,` +
				"tpad=start_duration=2:start_mode=clone:stop_duration=60:stop_mode=clone,trim=duration=60," +
				"setpts=(PTS-STARTPTS)*0.7,fps=30[p1]"
		);
		expect(fg.graph).toContain("fps=30,tpad=stop_duration=60:stop_mode=clone,trim=duration=60");
		expect(fg.graph).not.toContain("stop=-1");
		expect(fg.graph).toContain(`overlay=x=${p.screen.x}:y=${p.screen.y}`);
	});

	test("terminal gif skips the pre-roll with trim when the cast started first", () => {
		expect(fg.graph).toContain("[3:v]trim=start=10,setpts=PTS-STARTPTS,fps=30,tpad=stop_duration=60");
		expect(fg.graph).toContain(`scale=${layout.terminal.w}:${layout.terminal.h}`);
	});

	test("labels are drawtext from text files, enabled over their window", () => {
		const running = fg.texts.find((t) => t.text === "qa-b (retry)");
		expect(running).toBeDefined();
		expect(fg.graph).toContain(`textfile='/w/${running?.name}':expansion=none`);
		expect(fg.graph).toMatch(/fontcolor=0x30d158:[^,]*enable='gte\(t,41\.3\d*\)'/);
		expect(fg.graph).toContain("fontfile='/fonts/Menlo.ttc'");
	});

	test("ends by holding the final frame then yuv420p", () => {
		expect(fg.graph).toMatch(/tpad=stop_mode=clone:stop_duration=3,format=yuv420p\[out\]$/);
		expect(fg.args).toEqual(expect.arrayContaining(["-map", "[out]"]));
	});
});

describe("encoders", () => {
	test("mp4 is h264 yuv420p faststart at the given crf", () => {
		const a = mp4Args("/w/i.mp4", "/o/demo.mp4", 28);
		expect(a).toEqual(expect.arrayContaining(["libx264", "yuv420p", "+faststart", "28"]));
		expect(a.at(-1)).toBe("/o/demo.mp4");
	});
	test("webm is vp9 constant quality", () => {
		expect(webmArgs("/w/i.mp4", "/o/demo.webm")).toEqual(expect.arrayContaining(["libvpx-vp9", "-b:v", "0"]));
	});
	test("poster seeks from the end", () => {
		expect(posterArgs("/w/i.mp4", "/o/poster.jpg").slice(1, 4)).toEqual(["-y", "-sseof", "-1"]);
	});
	test("nextCrf raises crf until under budget, then gives up", () => {
		expect(nextCrf(5_000_000, 26, 6_000_000)).toBeNull();
		expect(nextCrf(9_000_000, 26, 6_000_000)).toBe(29);
		expect(nextCrf(9_000_000, 44, 6_000_000)).toBeNull();
	});
});

describe("parseCli", () => {
	test("positional dirs and defaults", () => {
		expect(parseCli(["rec", "out"])).toEqual({
			success: true,
			data: { recordDir: "rec", outDir: "out", duration: 45, width: 1920, hold: 3, maxBytes: 6_000_000 },
		});
	});
	test("flags", () => {
		const r = parseCli(["rec", "out", "--duration", "30", "--width", "1280"]);
		expect(r.success && r.data.duration === 30 && r.data.width === 1280).toBe(true);
	});
	test("usage on missing dirs or bad numbers", () => {
		expect(parseCli(["rec"]).success).toBe(false);
		expect(parseCli(["rec", "out", "--duration", "x"]).success).toBe(false);
	});
});
