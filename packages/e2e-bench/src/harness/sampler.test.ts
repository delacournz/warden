import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeExec } from "./exec";
import { ownerFilter } from "./residue";
import {
	androidTotals,
	type CpuReadings,
	cpuDeltas,
	groupOfArgv,
	hostGroupOf,
	isAndroidTarget,
	liveRoots,
	type PidStamps,
	type PsRow,
	parseAdbTop,
	parseCpuTime,
	parsePs,
	startSampler,
	summarize,
	type Tick,
	windowSummary,
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
		expect(exec.calls[0]?.args).toEqual(["-axo", "pid,ppid,rss,%cpu,time,lstart,command"]);
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

/** `ps -axo pid,ppid,rss,%cpu,time,lstart,command` as macOS prints it (`time` is `M:SS.ss`). */
function psTimed(rows: readonly { pid: number; ppid: number; rssKb: number; time: string; cmd: string }[]): string {
	return [
		"  PID  PPID    RSS  %CPU      TIME STARTED                      COMMAND",
		...rows.map(
			(r) => `  ${r.pid}  ${r.ppid} ${r.rssKb}   5.0 ${r.time.padStart(9)} Fri Oct 16 12:07:30 2026     ${r.cmd}`
		),
	].join("\n");
}

describe("cumulative CPU time (19-5)", () => {
	test("parseCpuTime reads macOS M:SS.ss and procps [DD-]HH:MM:SS", () => {
		expect(parseCpuTime("0:01.50")).toBeCloseTo(1.5, 6);
		expect(parseCpuTime("12:34.56")).toBeCloseTo(754.56, 6);
		expect(parseCpuTime("01:02:03")).toBe(3723);
		expect(parseCpuTime("1-00:00:01")).toBe(86_401);
		expect(parseCpuTime("Fri")).toBeUndefined();
		expect(parseCpuTime("")).toBeUndefined();
	});

	test("parsePs reads the time column next to lstart and keeps the command whole", () => {
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

	test("startSampler charges per-tick CPU-seconds from time deltas, for the host and the iOS sim", async () => {
		const snapshots = [
			psTimed([
				{ pid: 100, ppid: 1, rssKb: 1000, time: "0:10.00", cmd: "/opt/bun test --preload p" },
				{ pid: 200, ppid: 1, rssKb: 500, time: "1:00.00", cmd: "/x/launchd_sim /Devices/AAAA-BBBB/x" },
			]),
			psTimed([
				{ pid: 100, ppid: 1, rssKb: 1000, time: "0:10.40", cmd: "/opt/bun test --preload p" },
				{ pid: 101, ppid: 100, rssKb: 100, time: "0:00.10", cmd: "/usr/bin/xcrun simctl io" },
				{ pid: 200, ppid: 1, rssKb: 500, time: "1:00.25", cmd: "/x/launchd_sim /Devices/AAAA-BBBB/x" },
			]),
		];
		let call = 0;
		const exec = fakeExec([{ cmd: "ps", result: () => ({ stdout: snapshots[call++] ?? "" }) }]);
		let fire: () => Promise<void> = async () => undefined;
		let clock = 0;
		const sunk: Tick[] = [];
		const sampler = startSampler({
			exec,
			rootPids: () => [100],
			processPatterns: [],
			owned: () => [],
			simUdid: "AAAA-BBBB",
			platform: "ios",
			sink: (t) => sunk.push(t),
			setIntervalFn: (fn) => {
				fire = fn;
				return () => undefined;
			},
			now: () => clock,
		});
		await fire();
		clock = 500;
		await fire();
		const { host, sim, ticks } = await sampler.stop();
		expect(ticks).toHaveLength(2);
		expect(sunk[0]?.hostCpuSec).toBe(0);
		expect(sunk[1]?.hostCpuSec).toBeCloseTo(0.5, 6);
		expect(sunk[1]?.simCpuSec).toBeCloseTo(0.25, 6);
		expect(host.cpuSeconds).toBeCloseTo(0.5, 6);
		expect(host.cpuRatePct).toBeCloseTo(100, 6);
		expect(sim.cpuSeconds).toBeCloseTo(0.25, 6);
		expect(sampler.elapsed()).toBe(500);
	});
});

describe("host groups (19-7, 13-4)", () => {
	test("groupOfArgv names the process by its argv[0] basename and first argument", () => {
		expect(groupOfArgv("/Users/x/.bun/bin/bun", "test")).toBe("bun-test");
		expect(groupOfArgv("/Users/x/.bun/bin/bun", "/repo/apps/cli/src/cli.ts")).toBe("warden-cli");
		expect(groupOfArgv("/usr/local/bin/warden", "ui")).toBe("warden-cli");
		expect(groupOfArgv("/Users/x/bin/warden-simd", "--udid")).toBe("warden-simd");
		expect(groupOfArgv("/opt/sdk/platform-tools/adb", "-s")).toBe("adb");
		expect(groupOfArgv("/opt/sdk/emulator/emulator", "-avd")).toBe("emulator");
		expect(groupOfArgv("/opt/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64", "-x")).toBe("emulator");
		expect(groupOfArgv("/usr/bin/bun", "run")).toBeUndefined();
		expect(groupOfArgv("/opt/homebrew/bin/java", "-jar")).toBeUndefined();
	});

	test("hostGroupOf: own argv first, else the label of the nearest bench-spawned ancestor, else other", () => {
		const rows = parsePs(
			psTimed([
				{ pid: 100, ppid: 1, rssKb: 1, time: "0:00.00", cmd: "/opt/bun /repo/apps/cli/src/cli.ts ui snapshot" },
				{ pid: 101, ppid: 100, rssKb: 1, time: "0:00.00", cmd: "/usr/bin/xcrun simctl spawn" },
				{ pid: 102, ppid: 1, rssKb: 1, time: "0:00.00", cmd: "/Users/x/bin/warden-simd --udid A" },
				{ pid: 300, ppid: 1, rssKb: 1, time: "0:00.00", cmd: "/opt/homebrew/bin/java -jar maestro.jar" },
				{ pid: 301, ppid: 300, rssKb: 1, time: "0:00.00", cmd: "/opt/sdk/platform-tools/adb -s e shell" },
			])
		);
		const byPid = new Map(rows.map((r) => [r.pid, r]));
		const labels = new Map([[100, "warden-cli" as const]]);
		const group = (pid: number) => {
			const r = byPid.get(pid);
			return r === undefined ? undefined : hostGroupOf(r, byPid, labels);
		};
		expect(group(100)).toBe("warden-cli");
		expect(group(101)).toBe("warden-cli");
		expect(group(102)).toBe("warden-simd");
		expect(group(300)).toBe("other");
		expect(group(301)).toBe("adb");
	});

	test("ticks carry the host split by group and the Series sums it per group", async () => {
		const snapshots = [
			psTimed([
				{ pid: 100, ppid: 1, rssKb: 1000, time: "0:01.00", cmd: "/opt/bun test --preload p" },
				{ pid: 102, ppid: 1, rssKb: 400, time: "0:05.00", cmd: "/Users/x/bin/warden-simd --udid A" },
				{ pid: 110, ppid: 1, rssKb: 300, time: "0:00.50", cmd: "/opt/bun /repo/apps/cli/src/cli.ts ui close" },
			]),
			psTimed([
				{ pid: 100, ppid: 1, rssKb: 2000, time: "0:01.30", cmd: "/opt/bun test --preload p" },
				{ pid: 102, ppid: 1, rssKb: 400, time: "0:05.10", cmd: "/Users/x/bin/warden-simd --udid A" },
			]),
		];
		let call = 0;
		const exec = fakeExec([{ cmd: "ps", result: () => ({ stdout: snapshots[call++] ?? "" }) }]);
		let fire: () => Promise<void> = async () => undefined;
		let clock = 0;
		const sampler = startSampler({
			exec,
			rootPids: () => [100, 110],
			rootLabels: () => new Map([[110, "warden-cli" as const]]),
			processPatterns: [/warden-simd/],
			owned: (rows) => rows,
			platform: "ios",
			sink: () => undefined,
			setIntervalFn: (fn) => {
				fire = fn;
				return () => undefined;
			},
			now: () => clock,
		});
		await fire();
		clock = 1000;
		await fire();
		const { host, ticks } = await sampler.stop();
		expect(ticks[0]?.hostByGroup).toEqual({
			"bun-test": { cpuSec: 0, rssBytes: 1000 * 1024 },
			"warden-simd": { cpuSec: 0, rssBytes: 400 * 1024 },
			"warden-cli": { cpuSec: 0, rssBytes: 300 * 1024 },
		});
		expect(host.byGroup?.["bun-test"]?.cpuSeconds).toBeCloseTo(0.3, 6);
		expect(host.byGroup?.["bun-test"]).toMatchObject({ rssAvgBytes: 1500 * 1024, rssPeakBytes: 2000 * 1024 });
		expect(host.byGroup?.["warden-simd"]?.cpuSeconds).toBeCloseTo(0.1, 6);
		expect(host.byGroup?.["warden-cli"]).toEqual({ cpuSeconds: 0, rssAvgBytes: 150 * 1024, rssPeakBytes: 300 * 1024 });
		const groupRss = Object.values(host.byGroup ?? {}).reduce((a, g) => a + g.rssAvgBytes, 0);
		expect(groupRss).toBe(host.rssAvgBytes);
	});
});

describe("windowSummary (19-6)", () => {
	const tick = (t: number, hostCpuSec: number, hostRssBytes = 100): Tick => ({
		t,
		hostCpuPct: 50,
		hostRssBytes,
		simCpuPct: 0,
		simRssBytes: 0,
		hostCpuSec,
		simCpuSec: 0,
	});

	test("charges only the part of each tick interval inside the window", () => {
		// ticks every 500 ms, 0.5 CPU-s each (one busy core); the run is 250..1250 ms
		const ticks = [tick(0, 0), tick(500, 0.5), tick(1000, 0.5), tick(1500, 0.5, 900)];
		const w = windowSummary(ticks, 250, 1250);
		expect(w.window).toEqual({ startMs: 250, endMs: 1250 });
		expect(w.cpuSeconds).toBeCloseTo(1, 6);
		expect(w.host.cpuRatePct).toBeCloseTo(100, 6);
		expect(w.host.samples).toBe(2);
		expect(w.rssPeakBytes).toBe(100);
	});

	test("a whole-framework summary is unchanged by the window, and an idle tail lowers the rate, not the seconds", () => {
		const busy = [tick(0, 0), tick(500, 0.5), tick(1000, 0.5)];
		const idleTail = [...busy, tick(1500, 0), tick(2000, 0)];
		expect(summarize(busy).host.cpuSeconds).toBeCloseTo(1, 6);
		expect(summarize(idleTail).host.cpuSeconds).toBeCloseTo(1, 6);
		expect(summarize(idleTail).host.cpuRatePct).toBeCloseTo(50, 6);
		expect(windowSummary(idleTail, 0, 1000).cpuSeconds).toBeCloseTo(1, 6);
	});

	test("ticks without CPU time (older ndjson) leave cpuSeconds out", () => {
		const legacy: Tick = { t: 0, hostCpuPct: 1, hostRssBytes: 1, simCpuPct: 0, simRssBytes: 0 };
		expect(summarize([legacy, { ...legacy, t: 500 }]).host.cpuSeconds).toBeUndefined();
	});
});

describe("review fixes (bench-fidelity R1-R3, R8)", () => {
	const drive = (stdouts: readonly string[], extra: { logs?: string[] } = {}) => {
		let call = 0;
		const exec = fakeExec([{ cmd: "ps", result: () => ({ stdout: stdouts[call++] ?? "" }) }]);
		let fire: () => Promise<void> = async () => undefined;
		let clock = 0;
		const sampler = startSampler({
			exec,
			rootPids: () => [100],
			processPatterns: [],
			owned: () => [],
			platform: "ios",
			sink: () => undefined,
			...(extra.logs !== undefined ? { log: (line: string) => extra.logs?.push(line) } : {}),
			setIntervalFn: (fn) => {
				fire = fn;
				return () => undefined;
			},
			now: () => clock,
		});
		return {
			exec,
			sampler,
			async tickAt(t: number) {
				clock = t;
				await fire();
			},
		};
	};

	test("R1: a window over untimed ticks has no cpuSeconds (not 0)", () => {
		const legacy: Tick = { t: 0, hostCpuPct: 1, hostRssBytes: 1, simCpuPct: 0, simRssBytes: 0 };
		const w = windowSummary([legacy, { ...legacy, t: 500 }], 0, 500);
		expect(w.cpuSeconds).toBeUndefined();
		expect("cpuSeconds" in w).toBe(false);
		expect(w.rssPeakBytes).toBe(1);
	});

	test("R2: with a time + lstart header, a row whose time does not parse keeps its command and start time", () => {
		const odd = [
			"  PID  PPID    RSS  %CPU      TIME STARTED                      COMMAND",
			"  100     1   2048   5.0   0:01,50 Fri Oct 16 12:07:30 2026     /opt/bun test --preload p",
		].join("\n");
		expect(parsePs(odd)).toEqual([
			{
				pid: 100,
				ppid: 1,
				rssKb: 2048,
				cpuPct: 5,
				startedAt: "Fri Oct 16 12:07:30 2026",
				command: "/opt/bun test --preload p",
			},
		]);
	});

	test("R2: the sampler logs once when ps succeeded but no row had a CPU time", async () => {
		const odd = [
			"  PID  PPID    RSS  %CPU      TIME STARTED                      COMMAND",
			"  100     1   2048   5.0   0:01,50 Fri Oct 16 12:07:30 2026     /opt/bun test --preload p",
		].join("\n");
		const logs: string[] = [];
		const d = drive([odd, odd, odd], { logs });
		await d.tickAt(0);
		await d.tickAt(500);
		await d.tickAt(1000);
		const { host } = await d.sampler.stop();
		expect(host.cpuSeconds).toBeUndefined();
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("no row had a CPU time");
	});

	test("R3: a grandchild of warden-simd under bun test is warden-simd, not bun-test", () => {
		const rows = parsePs(
			psTimed([
				{ pid: 100, ppid: 1, rssKb: 1, time: "0:00.00", cmd: "/opt/bun test --preload p" },
				{ pid: 101, ppid: 100, rssKb: 1, time: "0:00.00", cmd: "/Users/x/bin/warden-simd --udid A" },
				{ pid: 102, ppid: 101, rssKb: 1, time: "0:00.00", cmd: "/usr/bin/xcrun simctl io A screenshot" },
				{ pid: 103, ppid: 102, rssKb: 1, time: "0:00.00", cmd: "/usr/bin/simctl io A screenshot" },
				{ pid: 104, ppid: 100, rssKb: 1, time: "0:00.00", cmd: "/usr/bin/xcrun simctl launch A" },
			])
		);
		const byPid = new Map(rows.map((r) => [r.pid, r]));
		const labels = new Map([[100, "bun-test" as const]]);
		const group = (pid: number) => {
			const r = byPid.get(pid);
			return r === undefined ? undefined : hostGroupOf(r, byPid, labels);
		};
		expect(group(102)).toBe("warden-simd");
		expect(group(103)).toBe("warden-simd");
		expect(group(104)).toBe("bun-test");
	});

	test("R8: ps runs with TZ=UTC (and the C locale) so lstart does not move with DST or the user's locale", async () => {
		const d = drive([psTimed([{ pid: 100, ppid: 1, rssKb: 1, time: "0:00.00", cmd: "/opt/bun test" }])]);
		await d.tickAt(0);
		await d.sampler.stop();
		const ps = d.exec.calls.find((c) => c.cmd === "ps");
		expect(ps?.options?.env).toMatchObject({ TZ: "UTC", LC_ALL: "C" });
	});
});

describe("exit CPU of bench-spawned roots (bench-fidelity-R4)", () => {
	const setup = (snapshots: readonly ((exitNow: () => void) => string)[]) => {
		let call = 0;
		let onPs: () => void = () => undefined;
		const exec = fakeExec([
			{
				cmd: "ps",
				result: () => ({ stdout: snapshots[call++]?.(() => onPs()) ?? "" }),
			},
		]);
		let fire: () => Promise<void> = async () => undefined;
		let clock = 0;
		const roots: number[] = [];
		const sampler = startSampler({
			exec,
			rootPids: () => [...roots],
			rootLabels: () => new Map([[100, "bun-test" as const]]),
			processPatterns: [],
			owned: () => [],
			platform: "ios",
			sink: () => undefined,
			setIntervalFn: (fn) => {
				fire = fn;
				return () => undefined;
			},
			now: () => clock,
		});
		return {
			sampler,
			roots,
			setClock: (t: number) => {
				clock = t;
			},
			duringPs: (fn: () => void) => {
				onPs = fn;
			},
			async tickAt(t: number) {
				clock = t;
				await fire();
			},
		};
	};
	const bunTest = (time: string) => ({ pid: 100, ppid: 1, rssKb: 1, time, cmd: "/opt/bun test --preload p" });
	const child = (time: string) => ({ pid: 101, ppid: 100, rssKb: 1, time, cmd: "/usr/bin/xcrun simctl io" });

	test("a root's CPU at exit beyond what ps last saw of its tree is charged at the exit time", async () => {
		const d = setup([() => psTimed([]), () => psTimed([bunTest("0:00.40"), child("0:00.10")]), () => psTimed([])]);
		await d.tickAt(0);
		d.roots.push(100);
		await d.tickAt(500);
		d.setClock(700);
		d.sampler.exited(100, 1.2);
		await d.tickAt(1000);
		const { host, ticks, exits } = await d.sampler.stop();
		expect(exits).toEqual([{ t: 700, cpuSec: expect.closeTo(0.7, 6), group: "bun-test" }]);
		// 0.5 seen by the ticks (a process born since the baseline) + 0.7 at exit = the root's rusage
		expect(host.cpuSeconds).toBeCloseTo(1.2, 6);
		expect(host.byGroup?.["bun-test"]?.cpuSeconds).toBeCloseTo(1.2, 6);
		expect(windowSummary(ticks, 600, 800, exits).cpuSeconds).toBeCloseTo(0.7, 6);
		expect(windowSummary(ticks, 800, 1000, exits).cpuSeconds).toBeCloseTo(0, 6);
	});

	test("a root no tick saw is charged its whole CPU time", async () => {
		const launchd = { pid: 1, ppid: 0, rssKb: 1, time: "1:00.00", cmd: "/sbin/launchd" };
		const d = setup([() => psTimed([launchd]), () => psTimed([launchd])]);
		await d.tickAt(0);
		d.roots.push(100);
		d.setClock(200);
		d.sampler.exited(100, 0.3);
		await d.tickAt(500);
		const { host, exits } = await d.sampler.stop();
		expect(exits).toEqual([{ t: 200, cpuSec: 0.3, group: "bun-test" }]);
		expect(host.cpuSeconds).toBeCloseTo(0.3, 6);
	});

	test("an exit reported while a tick's ps is in flight is settled after that tick (no double charge)", async () => {
		const d = setup([
			() => psTimed([bunTest("0:00.20")]),
			(exitNow) => {
				exitNow();
				return psTimed([bunTest("0:00.50")]);
			},
		]);
		d.roots.push(100);
		await d.tickAt(0);
		d.duringPs(() => d.sampler.exited(100, 0.9));
		await d.tickAt(500);
		const { host, exits } = await d.sampler.stop();
		expect(exits).toHaveLength(1);
		expect(exits[0]?.cpuSec).toBeCloseTo(0.4, 6);
		// 0.3 tick delta + 0.4 at exit = 0.9 - 0.2 (the baseline reading)
		expect(host.cpuSeconds).toBeCloseTo(0.7, 6);
	});

	test("untimed ticks take no exit charge (no CPU-seconds at all)", () => {
		const legacy: Tick = { t: 0, hostCpuPct: 1, hostRssBytes: 1, simCpuPct: 0, simRssBytes: 0 };
		const w = windowSummary([legacy, { ...legacy, t: 500 }], 0, 500, [{ t: 100, cpuSec: 1, group: "other" }]);
		expect(w.cpuSeconds).toBeUndefined();
	});
});
