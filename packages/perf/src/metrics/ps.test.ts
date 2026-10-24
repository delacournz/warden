import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CpuReadings,
	cpuDeltas,
	findByExecutable,
	type PsRow,
	parseAdbTop,
	parseCpuTime,
	parsePs,
	withDescendants,
} from "./ps";

const fx = (name: string) => readFileSync(join(import.meta.dir, "..", "..", "fixtures", name), "utf8");

/** `ps -axo pid,ppid,rss,%cpu,time,lstart,command` as macOS prints it (`time` is `M:SS.ss`). */
function psTimed(rows: readonly { pid: number; ppid: number; rssKb: number; time: string; cmd: string }[]): string {
	return [
		"  PID  PPID    RSS  %CPU      TIME STARTED                      COMMAND",
		...rows.map(
			(r) => `  ${r.pid}  ${r.ppid} ${r.rssKb}   5.0 ${r.time.padStart(9)} Fri Oct 16 12:07:30 2026     ${r.cmd}`
		),
	].join("\n");
}

describe("parsePs", () => {
	test("parses rows and skips the header", () => {
		const rows = parsePs(fx("ps.txt"));
		expect(rows).toHaveLength(14);
		expect(rows[2]).toEqual({
			pid: 101,
			ppid: 100,
			rssKb: 102400,
			cpuPct: 20.5,
			command: "/usr/bin/node /repo/runner.js --flag value",
		});
	});

	test("reads the lstart column into startedAt and keeps the command whole", () => {
		const rows = parsePs(fx("ps-lstart.txt"));
		expect(rows).toHaveLength(6);
		expect(rows[2]).toEqual({
			pid: 101,
			ppid: 100,
			rssKb: 102400,
			cpuPct: 20.5,
			startedAt: "Fri Oct 16 12:07:31 2026",
			command: "/usr/bin/node /repo/runner.js --flag value",
		});
		expect(rows[0]?.startedAt).toBe("Thu Oct  1 08:00:00 2026");
		expect(parsePs(fx("ps.txt")).every((r) => r.startedAt === undefined)).toBe(true);
	});

	test("reads the time column next to lstart", () => {
		const rows = parsePs(psTimed([{ pid: 100, ppid: 1, rssKb: 2048, time: "1:02.25", cmd: "bun test --preload x" }]));
		expect(rows).toEqual([
			{
				pid: 100,
				ppid: 1,
				rssKb: 2048,
				cpuPct: 5,
				cpuTimeSec: 62.25,
				startedAt: "Fri Oct 16 12:07:30 2026",
				command: "bun test --preload x",
			},
		]);
	});
});

describe("parseCpuTime", () => {
	test("reads macOS M:SS.ss and procps [DD-]HH:MM:SS", () => {
		expect(parseCpuTime("0:01.50")).toBeCloseTo(1.5, 6);
		expect(parseCpuTime("12:34.56")).toBeCloseTo(754.56, 6);
		expect(parseCpuTime("01:02:03")).toBe(3723);
		expect(parseCpuTime("1-00:00:01")).toBe(86_401);
		expect(parseCpuTime("Fri")).toBeUndefined();
		expect(parseCpuTime("")).toBeUndefined();
	});
});

describe("parseAdbTop", () => {
	test("parses toybox rows with unit suffixes", () => {
		const rows = parseAdbTop(fx("adb-top.txt"));
		expect(rows).toHaveLength(4);
		expect(rows[0]).toEqual({
			pid: 4321,
			rssBytes: 250 * 1024 ** 2,
			cpuPct: 25,
			name: "nz.co.delacour.warden.example",
		});
	});
});

describe("withDescendants", () => {
	test("returns the seeds plus every transitive child", () => {
		const rows = parsePs(fx("ps.txt"));
		const tree = withDescendants(rows, new Set([100]));
		expect(tree.has(100)).toBe(true);
		expect(tree.has(101)).toBe(true);
		expect(tree.has(1)).toBe(false);
	});
});

describe("cpuDeltas", () => {
	const row = (pid: number, cpuTimeSec: number, startedAt = "Fri Oct 16 12:07:30 2026"): PsRow => ({
		pid,
		ppid: 1,
		rssKb: 1,
		cpuPct: 0,
		cpuTimeSec,
		startedAt,
		command: "x",
	});

	test("the first snapshot is the baseline: nothing a process used before the sampler started is charged", () => {
		const prev: CpuReadings = new Map();
		const first = cpuDeltas([row(100, 30), row(101, 2)], prev, true);
		expect([...first.values()]).toEqual([0, 0]);
		const second = cpuDeltas([row(100, 30.5), row(101, 2.25)], prev, false);
		expect(second.get(100)).toBeCloseTo(0.5, 6);
		expect(second.get(101)).toBeCloseTo(0.25, 6);
	});

	test("a process born after the last snapshot is charged all its CPU time; a dead one drops out", () => {
		const prev: CpuReadings = new Map();
		cpuDeltas([row(100, 1)], prev, true);
		const d = cpuDeltas([row(200, 0.4)], prev, false);
		expect(d.get(200)).toBeCloseTo(0.4, 6);
		expect(d.has(100)).toBe(false);
		expect(prev.has(100)).toBe(false);
	});

	test("a reused pid (new start time) or a smaller reading is a new process, never a negative delta", () => {
		const prev: CpuReadings = new Map();
		cpuDeltas([row(100, 5), row(101, 5)], prev, true);
		const d = cpuDeltas(
			[row(100, 0.3, "Fri Oct 16 12:09:00 2026"), { ...row(101, 0.2), startedAt: undefined }],
			prev,
			false
		);
		expect(d.get(100)).toBeCloseTo(0.3, 6);
		expect(d.get(101)).toBeCloseTo(0.2, 6);
	});
});

describe("findByExecutable", () => {
	const rows = parsePs(fx("ps-timed-app.txt"));
	const exe =
		"/Users/chris/Library/Developer/CoreSimulator/Devices/U1/data/Containers/Bundle/Application/AAAA-1111/Example.app/Example";

	test("matches the main executable by full path, not its extensions", () => {
		expect(findByExecutable(rows, exe)?.pid).toBe(845);
	});
	test("a prefix of another path is not a match", () => {
		expect(findByExecutable(rows, exe.replace("Example.app/Example", "Example.app/Exam"))).toBeUndefined();
	});
	test("not running: undefined", () => {
		expect(findByExecutable(rows, "/nope/App.app/App")).toBeUndefined();
	});
});
