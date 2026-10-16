import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeExec } from "./exec";
import { ownerFilter } from "./residue";
import {
	androidTotals,
	isAndroidTarget,
	liveRoots,
	type PidStamps,
	parseAdbTop,
	parsePs,
	startSampler,
	summarize,
	type Tick,
} from "./sampler";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

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
});

describe("parsePs with a start time", () => {
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

describe("android sampling targets", () => {
	test("matches the app under test and every framework's on-device helper, ignoring case", () => {
		const helpers = [
			"nz.co.delacour.warden.example",
			"nz.co.delacour.warden.example.test",
			"app_process / com.android.commands.uiautomator runtime",
			"androidx.test.runner instrumentation",
			"dev.mobile.maestro",
			"dev.mobile.maestro.test",
			"Dev.Mobile.Maestro",
			"com.callstack.agentdevice.snapshothelper",
			"app_process / com.callstack.agentdevice.snapshothelper/.SnapshotInstrumentation",
			"SnapshotInstrumentation",
			"warden-uiad",
			"app_process /system/bin --nice-name=warden_uiad com.warden.uiad.Main",
			"app_process / nz.co.delacour.warden.uiad.Main",
			"com.argent.androiddevtools",
		];
		for (const name of helpers) expect(isAndroidTarget(name), name).toBe(true);
	});

	test("ignores the rest of the device", () => {
		for (const name of ["system_server", "com.android.systemui", "zygote64", "adbd", "com.google.android.gms"])
			expect(isAndroidTarget(name), name).toBe(false);
	});

	test("totals count maestro, agent-device, argent and warden-uiad, not only warden's own helpers", () => {
		const rows = parseAdbTop(fx("adb-top-helpers.txt"));
		expect(rows).toHaveLength(13);
		const only = (re: RegExp) => androidTotals(rows.filter((r) => re.test(r.name)));
		expect(only(/maestro/)).toEqual({ cpuPct: 18, rssBytes: 215 * 1024 ** 2 });
		expect(only(/agentdevice/)).toEqual({ cpuPct: 10, rssBytes: 128 * 1024 ** 2 });
		expect(only(/warden-uiad/)).toEqual({ cpuPct: 3, rssBytes: 50 * 1024 ** 2 });
		expect(only(/argent/)).toEqual({ cpuPct: 2, rssBytes: 64 * 1024 ** 2 });
		expect(androidTotals(rows)).toEqual({ cpuPct: 74, rssBytes: 887 * 1024 ** 2 });
	});
});

describe("liveRoots", () => {
	const at = (startedAt: string, pid = 100) => ({
		pid,
		ppid: 1,
		rssKb: 1,
		cpuPct: 0,
		startedAt,
		command: "bun",
	});

	test("stamps a root on first sight and keeps counting it while the start time matches", () => {
		const stamps: PidStamps = new Map();
		const a = at("Fri Oct 16 12:07:30 2026");
		expect(liveRoots([100], [a], stamps)).toEqual([100]);
		expect(stamps.get(100)).toEqual({ kind: "started", startedAt: "Fri Oct 16 12:07:30 2026" });
		expect(liveRoots([100], [a], stamps)).toEqual([100]);
	});

	test("drops a pid the OS handed to a different process (start time changed)", () => {
		const stamps: PidStamps = new Map();
		liveRoots([100], [at("Fri Oct 16 12:07:30 2026")], stamps);
		expect(liveRoots([100], [at("Fri Oct 16 12:09:41 2026")], stamps)).toEqual([]);
		expect(liveRoots([100], [], stamps)).toEqual([]);
	});

	test("a root that was gone before it was first seen never counts, even if the pid comes back", () => {
		const stamps: PidStamps = new Map();
		expect(liveRoots([100], [], stamps)).toEqual([]);
		expect(liveRoots([100], [at("Fri Oct 16 12:09:41 2026")], stamps)).toEqual([]);
		expect(stamps.get(100)).toEqual({ kind: "ignored" });
	});

	test("rows without a start column cannot be verified and still count (legacy ps output)", () => {
		const stamps: PidStamps = new Map();
		const legacy = { pid: 100, ppid: 1, rssKb: 1, cpuPct: 0, command: "bun" };
		expect(liveRoots([100], [legacy], stamps)).toEqual([100]);
		expect(stamps.size).toBe(0);
	});

	test("pids that were never registered are not roots", () => {
		expect(liveRoots([], [at("Fri Oct 16 12:07:30 2026")], new Map())).toEqual([]);
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
			processPatterns: [/maestro/, /simulator-server/],
			owned: (rows) => ownerFilter(rows, { udid: "AAAA-BBBB", benchPids: () => [100, 300], ownedPaths: [] }),
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
			owned: () => [],
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

	test("android: counts maestro, agent-device and warden-uiad helpers in the sim column", async () => {
		const exec = fakeExec([
			{ cmd: "ps", result: { stdout: fx("ps.txt") } },
			{ cmd: "adb", result: { stdout: fx("adb-top-helpers.txt") } },
		]);
		let fire: () => Promise<void> = async () => undefined;
		const sunk: Tick[] = [];
		const sampler = startSampler({
			exec,
			rootPids: () => [],
			processPatterns: [],
			owned: () => [],
			simUdid: "emulator-5554",
			platform: "android",
			sink: (t) => sunk.push(t),
			setIntervalFn: (fn) => {
				fire = fn;
				return () => undefined;
			},
		});
		await fire();
		await sampler.stop();
		expect(sunk[0]?.simCpuPct).toBe(74);
		expect(sunk[0]?.simRssBytes).toBe(887 * 1024 ** 2);
	});

	test("reads the root pids before ps so a process spawned mid-tick is in the next snapshot", async () => {
		const order: string[] = [];
		const exec = fakeExec([
			{
				cmd: "ps",
				result: () => {
					order.push("ps");
					return { stdout: fx("ps-lstart.txt") };
				},
			},
		]);
		let fire: () => Promise<void> = async () => undefined;
		const sampler = startSampler({
			exec,
			rootPids: () => {
				order.push("roots");
				return [100];
			},
			processPatterns: [],
			owned: () => [],
			platform: "ios",
			sink: () => undefined,
			setIntervalFn: (fn) => {
				fire = fn;
				return () => undefined;
			},
		});
		await fire();
		await sampler.stop();
		expect(order).toEqual(["roots", "ps"]);
		expect(exec.calls[0]?.args).toEqual(["-axo", "pid,ppid,rss,%cpu,lstart,command"]);
	});

	test("a reused root pid stops counting: the new process and its children are not host load", async () => {
		const original = fx("ps-lstart.txt");
		const reused = [
			"  PID  PPID    RSS  %CPU STARTED                      COMMAND",
			"  100     1 900000  80.0 Fri Oct 16 12:20:00 2026     /Applications/Slack.app/Contents/MacOS/Slack",
			"  101   100 400000  40.0 Fri Oct 16 12:20:01 2026     /Applications/Slack.app/Contents/Frameworks/Slack Helper",
			"  300     1  20480   1.0 Fri Oct 16 12:07:33 2026     /opt/homebrew/bin/java -jar maestro-cli.jar",
		].join("\n");
		let call = 0;
		const exec = fakeExec([{ cmd: "ps", result: () => ({ stdout: ++call === 1 ? original : reused }) }]);
		let fire: () => Promise<void> = async () => undefined;
		const sunk: Tick[] = [];
		const sampler = startSampler({
			exec,
			rootPids: () => [100, 300],
			processPatterns: [],
			owned: () => [],
			platform: "ios",
			sink: (t) => sunk.push(t),
			setIntervalFn: (fn) => {
				fire = fn;
				return () => undefined;
			},
		});
		await fire();
		await fire();
		await sampler.stop();
		expect(sunk[0]?.hostCpuPct).toBe(10 + 20.5 + 5 + 1);
		expect(sunk[1]?.hostCpuPct).toBe(1);
		expect(sunk[1]?.hostRssBytes).toBe(20480 * 1024);
	});
});
