import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeExec } from "./exec";
import { androidTotals, parseAdbTop, parsePs, startSampler, summarize, type Tick } from "./sampler";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

describe("parsePs", () => {
	test("parses rows and skips the header", () => {
		const rows = parsePs(fx("ps.txt"));
		expect(rows).toHaveLength(9);
		expect(rows[2]).toEqual({
			pid: 101,
			ppid: 100,
			rssKb: 102400,
			cpuPct: 20.5,
			command: "/usr/bin/node /repo/runner.js --flag value",
		});
	});
});

describe("parseAdbTop", () => {
	test("parses toybox rows with unit suffixes and totals the targets", () => {
		const rows = parseAdbTop(fx("adb-top.txt"));
		expect(rows).toHaveLength(4);
		expect(rows[0]).toEqual({
			pid: 4321,
			rssBytes: 250 * 1024 ** 2,
			cpuPct: 25,
			name: "nz.co.delacour.warden.example",
		});
		expect(androidTotals(rows)).toEqual({ cpuPct: 40, rssBytes: 390 * 1024 ** 2 });
	});
});

describe("summarize", () => {
	test("avg and peak per series", () => {
		const t = (hostCpuPct: number, hostRssBytes: number): Tick => ({
			t: 0,
			hostCpuPct,
			hostRssBytes,
			simCpuPct: 1,
			simRssBytes: 10,
		});
		const { host, sim } = summarize([t(10, 100), t(30, 300)]);
		expect(host).toEqual({ cpuAvgPct: 20, cpuPeakPct: 30, rssAvgBytes: 200, rssPeakBytes: 300, samples: 2 });
		expect(sim.samples).toBe(2);
		expect(summarize([]).host.samples).toBe(0);
	});
});

describe("startSampler", () => {
	test("ios: host tree + pattern matches, sim tree by udid, driven by hand", async () => {
		const exec = fakeExec([{ cmd: "ps", result: { stdout: fx("ps.txt") } }]);
		let fire: () => Promise<void> = async () => undefined;
		let cancelled = false;
		const sunk: Tick[] = [];
		const sampler = startSampler({
			exec,
			rootPids: () => [100],
			processPatterns: [/maestro/],
			simUdid: "AAAA-BBBB",
			platform: "ios",
			sink: (t) => sunk.push(t),
			setIntervalFn: (fn) => {
				fire = fn;
				return () => {
					cancelled = true;
				};
			},
			now: () => 0,
		});
		await fire();
		await fire();
		const { host, sim } = await sampler.stop();
		expect(cancelled).toBe(true);
		expect(exec.calls.filter((c) => c.cmd === "ps")).toHaveLength(2);
		// host: pids 100,101,102 (tree) + 300 (java maestro)
		expect(sunk[0]?.hostCpuPct).toBe(10 + 20.5 + 5 + 1);
		expect(sunk[0]?.hostRssBytes).toBe((204800 + 102400 + 51200 + 20480) * 1024);
		// sim: 200 (udid in cmd) + 201 + 202, but warden-simd (102) belongs to host
		expect(sunk[0]?.simCpuPct).toBe(3 + 7.5 + 2);
		expect(host.samples).toBe(2);
		expect(sim.rssPeakBytes).toBe((40960 + 81920 + 30720) * 1024);
	});

	test("android: adb top every 2 s, last reading reused between", async () => {
		const exec = fakeExec([
			{ cmd: "ps", result: { stdout: fx("ps.txt") } },
			{ cmd: "adb", result: { stdout: fx("adb-top.txt") } },
		]);
		let fire: () => Promise<void> = async () => undefined;
		const sunk: Tick[] = [];
		const sampler = startSampler({
			exec,
			rootPids: () => [],
			processPatterns: [],
			simUdid: "emulator-5554",
			platform: "android",
			intervalMs: 500,
			sink: (t) => sunk.push(t),
			setIntervalFn: (fn) => {
				fire = fn;
				return () => undefined;
			},
		});
		for (let i = 0; i < 5; i++) await fire();
		await sampler.stop();
		const adbCalls = exec.calls.filter((c) => c.cmd === "adb");
		expect(adbCalls).toHaveLength(2);
		expect(adbCalls[0]?.args).toEqual(["-s", "emulator-5554", "shell", "top", "-n", "1", "-b"]);
		expect(sunk.every((t) => t.simCpuPct === 40)).toBe(true);
	});
});
