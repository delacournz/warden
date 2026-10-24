import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeCpu, analyzeHangs, analyzeRss, cpuFindings, hangFindings, rssFindings } from "./analyze";
import { parseTpOutput } from "./tp-output";

const rows = (n: string) => parseTpOutput(readFileSync(join(import.meta.dir, "../../fixtures", n), "utf8"));

describe("cpu", () => {
	const cpu = analyzeCpu(rows("trace-processor-cpu-hotspots.txt"));
	test("shares of all samples, busiest thread first", () => {
		expect(cpu.totalSamples).toBe(941);
		expect(cpu.threads[0]?.thread).toBe("mqt_v_js");
		expect(cpu.functions[0]?.selfPct).toBeCloseTo(74.4, 1);
	});
	test("critical over 15%, warn from 3%, nothing below", () => {
		const f = cpuFindings(cpu, 100);
		expect(f.map((x) => x.severity)).toEqual(["critical", "critical", "warn"]);
		expect(f[0]).toMatchObject({ kind: "native-hotspot", thread: "mqt_v_js", costMs: 7000 });
	});
	test("no samples, no findings", () => {
		expect(cpuFindings(analyzeCpu([]), 100)).toEqual([]);
	});
});

describe("hangs", () => {
	const hangs = analyzeHangs(rows("trace-processor-ui-hangs.txt"), rows("trace-processor-hang-folds.txt"));
	test("folds main-thread buckets onto each frame", () => {
		expect(hangs.totalFrames).toBe(600);
		expect(hangs.hangs[0]?.durMs).toBe(412);
		expect(hangs.hangs[0]?.main).toMatchObject({ running: 300, runnable: 20, sleeping: 12, io: 60, gc: 95 });
		expect(hangs.hangs[1]?.main.running).toBe(20);
	});
	test("hang finding for the 412ms frame only, with a fix from the dominant state", () => {
		const f = hangFindings(hangs);
		expect(f).toHaveLength(1);
		expect(f[0]).toMatchObject({ kind: "hang", severity: "warn", atMs: 3200 });
		expect(f[0]?.fix).toContain("busy running code");
		expect(f[0]?.evidence).toContain("gc 95ms");
	});
	test("jank finding past 5% of frames", () => {
		const many = analyzeHangs(
			Array.from({ length: 10 }, () => ({
				at_ns: "1",
				dur_ns: "20000000",
				jank_type: "App Deadline Missed",
				layer: "",
				total_frames: "100",
			})),
			[]
		);
		expect(hangFindings(many).map((x) => x.kind)).toEqual(["jank"]);
	});
});

describe("rss", () => {
	test("growing series is a memory-growth finding", () => {
		const rss = analyzeRss(rows("trace-processor-memory-rss.txt"));
		expect(rss?.slopeKbPerSec).toBeGreaterThan(10_000);
		expect(rssFindings(rss)[0]).toMatchObject({ kind: "memory-growth", severity: "critical" });
	});
	test("flat or short series is quiet", () => {
		const flat = analyzeRss(parseTpOutput('"t_ns","bytes"\n0,100000000\n10000000000,100000000\n'));
		expect(rssFindings(flat)).toEqual([]);
		expect(analyzeRss([])).toBeUndefined();
	});
});
