import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeExec } from "./exec";
import {
	aggregateProcesses,
	parsePs,
	processLabel,
	processReadings,
	startSampler,
	type Tick,
	windowSummary,
} from "./sampler";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

describe("processLabel (CPU-2.1)", () => {
	const label = (command: string): string => {
		const [argv0 = "", ...rest] = command.split(/\s+/);
		return processLabel(argv0, rest.join(" "));
	};
	test("names the tools the bench cares about", () => {
		expect(label("/Users/x/bin/warden-simd --udid AAAA")).toBe("warden-simd");
		expect(label("/Users/x/.bun/bin/bun test --preload p suites")).toBe("bun test");
		expect(label("bun /repo/apps/cli/src/cli.ts e2e example")).toBe("bun cli.ts");
		expect(label("bun --bun run /repo/scripts/x.ts")).toBe("bun x.ts");
		expect(label("bun")).toBe("bun");
		expect(label("/usr/bin/node /repo/runner.js --flag value")).toBe("node runner.js");
		expect(label("/usr/local/bin/warden e2e example")).toBe("warden e2e");
		expect(label("/X/Resources/SimulatorFrameworkBridge-iOS serve --udid AAAA")).toBe(
			"SimulatorFrameworkBridge-iOS serve"
		);
	});
	test("xcrun simctl keeps its subcommand, bare simctl and other xcrun tools do not mix", () => {
		expect(label("/usr/bin/xcrun simctl launch AAAA nz.co.x")).toBe("xcrun simctl launch");
		expect(label("/usr/bin/xcrun --sdk iphoneos simctl")).toBe("xcrun simctl");
		expect(label("/usr/bin/xcrun xcodebuild -version")).toBe("xcrun xcodebuild");
		expect(label("/usr/bin/xcrun")).toBe("xcrun");
		expect(label("/Applications/Xcode.app/Contents/Developer/usr/bin/simctl launch AAAA")).toBe("simctl");
	});
	test("the long tail is the basename of argv0 and never holds a udid", () => {
		expect(label("/Volumes/iOS/usr/libexec/backboardd")).toBe("backboardd");
		expect(label("/Volumes/iOS/CoreServices/SpringBoard.app/SpringBoard")).toBe("SpringBoard");
		expect(label("/D/AAAA-BBBB/Containers/Bundle/Application/A/Example.app/Example")).toBe("Example");
		expect(label("/Applications/Xcode.app/launchd_sim /Devices/AAAA-BBBB/x.plist")).toBe("launchd_sim");
		expect(processLabel("", "")).toBe("unknown");
	});
});

describe("per-process attribution (CPU-2.1)", () => {
	/** two real-shaped `ps` snapshots (time + lstart): +0.6 s bun test, +0.3 s warden-simd, sim backboardd +0.5 s */
	const snapshots = [fx("ps-time-1.txt"), fx("ps-time-2.txt")];

	async function run() {
		let call = 0;
		const exec = fakeExec([{ cmd: "ps", result: () => ({ stdout: snapshots[call++] ?? snapshots[1] ?? "" }) }]);
		let fire: () => Promise<void> = async () => undefined;
		let clock = 0;
		const sampler = startSampler({
			exec,
			rootPids: () => [100],
			processPatterns: [],
			owned: () => [],
			simUdid: "AAAA-BBBB",
			platform: "ios",
			sink: () => undefined,
			setIntervalFn: (fn) => {
				fire = fn;
				return () => undefined;
			},
			now: () => clock,
		});
		await fire();
		clock = 500;
		await fire();
		return { sampler, ticks: (await sampler.stop()).ticks };
	}

	test("each tick lists host and sim processes by label with their CPU delta and RSS", async () => {
		const { ticks } = await run();
		const second = ticks[1]?.processes ?? [];
		const by = (scope: string, name: string) => second.find((p) => p.scope === scope && p.name === name);
		expect(by("host", "bun test")?.cpuSec).toBeCloseTo(0.6, 6);
		expect(by("host", "warden-simd")?.cpuSec).toBeCloseTo(0.3, 6);
		expect(by("host", "SimulatorFrameworkBridge-iOS serve")?.cpuSec).toBeCloseTo(0.1, 6);
		expect(by("host", "xcrun simctl launch")?.cpuSec).toBeCloseTo(0.2, 6);
		expect(by("host", "simctl")?.cpuSec).toBeCloseTo(0.05, 6);
		expect(by("sim", "backboardd")?.cpuSec).toBeCloseTo(0.5, 6);
		expect(by("sim", "backboardd")?.rssBytes).toBe(81920 * 1024);
		expect(by("sim", "Example")?.cpuSec).toBeCloseTo(0.4, 6);
		expect(by("host", "launchd_sim")).toBeUndefined();
		const sum = (scope: string) => second.filter((p) => p.scope === scope).reduce((a, p) => a + p.cpuSec, 0);
		expect(sum("host")).toBeCloseTo(ticks[1]?.hostCpuSec ?? Number.NaN, 6);
		expect(sum("sim")).toBeCloseTo(ticks[1]?.simCpuSec ?? Number.NaN, 6);
	});

	test("a process with no CPU and under 1 MiB RSS is left out of a tick", () => {
		const rows = parsePs(fx("ps-time-2.txt"));
		const tiny = rows.map((r) => (r.pid === 105 ? { ...r, rssKb: 100 } : r));
		const pids = new Set([100, 105]);
		const idle = processReadings(tiny, pids, new Map([[100, 0.1]]), "host");
		expect(idle.map((p) => p.pid)).toEqual([100]);
		const busy = processReadings(tiny, pids, new Map([[105, 0.01]]), "host");
		expect(busy.map((p) => p.pid)).toEqual([100, 105]);
	});

	test("aggregateProcesses sums a window by label, sorted by CPU, shares add to 100 per scope", async () => {
		const { ticks } = await run();
		const rows = aggregateProcesses(ticks, 0, 500);
		const host = rows.filter((r) => r.scope === "host");
		expect(host.map((r) => r.name)).toEqual([
			"bun test",
			"warden-simd",
			"xcrun simctl launch",
			"SimulatorFrameworkBridge-iOS serve",
			"simctl",
		]);
		expect(host[0]).toMatchObject({ name: "bun test", spawnCount: 1 });
		expect(host[0]?.cpuSeconds).toBeCloseTo(0.6, 6);
		expect(host.reduce((a, r) => a + r.shareOfScopePct, 0)).toBeCloseTo(100, 6);
		const sim = rows.filter((r) => r.scope === "sim");
		expect(sim[0]?.name).toBe("backboardd");
		expect(sim.reduce((a, r) => a + r.shareOfScopePct, 0)).toBeCloseTo(100, 6);
		expect(host[0]?.rssAvgBytes).toBe(204800 * 1024);
		expect(host[0]?.rssPeakBytes).toBe(204800 * 1024);
	});

	test("the host rows sum to the window's host CPU-seconds, exit charges included", async () => {
		const { ticks } = await run();
		const exits = [{ t: 400, cpuSec: 0.7, group: "bun-test" as const, name: "bun test" }];
		const rows = aggregateProcesses(ticks, 0, 500, exits);
		const host = rows.filter((r) => r.scope === "host");
		expect(host.find((r) => r.name === "bun test (exit charge)")?.cpuSeconds).toBeCloseTo(0.7, 6);
		const w = windowSummary(ticks, 0, 500, exits);
		expect(host.reduce((a, r) => a + r.cpuSeconds, 0)).toBeCloseTo(w.cpuSeconds ?? Number.NaN, 6);
		expect(w.processes).toEqual(rows);
		const unnamed = aggregateProcesses(ticks, 0, 500, [{ t: 400, cpuSec: 0.1, group: "adb" }]);
		expect(unnamed.some((r) => r.name === "adb (exit charge)")).toBe(true);
	});

	test("a window prorates a tick interval it only partly covers", async () => {
		const { ticks } = await run();
		const rows = aggregateProcesses(ticks, 250, 500);
		expect(rows.find((r) => r.name === "bun test")?.cpuSeconds).toBeCloseTo(0.3, 6);
	});

	test("top 12 per scope, the rest summed into one other row per scope", () => {
		const procs = (scope: "host" | "sim") =>
			Array.from({ length: 15 }, (_, i) => ({
				pid: (scope === "host" ? 1000 : 2000) + i,
				name: `p${String(i).padStart(2, "0")}`,
				scope,
				cpuSec: (i + 1) / 10,
				rssBytes: 1024 * 1024 * (i + 1),
			}));
		const base = { hostCpuPct: 0, hostRssBytes: 0, simCpuPct: 0, simRssBytes: 0 };
		const ticks: Tick[] = [
			{ ...base, t: 0, processes: [] },
			{ ...base, t: 500, processes: [...procs("host"), ...procs("sim")] },
		];
		const rows = aggregateProcesses(ticks, 0, 500);
		for (const scope of ["host", "sim"] as const) {
			const mine = rows.filter((r) => r.scope === scope);
			expect(mine).toHaveLength(13);
			expect(mine[0]?.name).toBe("p14");
			const other = mine.at(-1);
			expect(other?.name).toBe("other");
			expect(other?.spawnCount).toBe(3);
			expect(other?.cpuSeconds).toBeCloseTo(0.1 + 0.2 + 0.3, 6);
			expect(other?.rssPeakBytes).toBe(1024 * 1024 * (1 + 2 + 3));
			expect(other?.rssAvgBytes).toBe((1024 * 1024 * (1 + 2 + 3)) / 2);
			expect(mine.reduce((a, r) => a + r.shareOfScopePct, 0)).toBeCloseTo(100, 6);
		}
	});

	test("old ticks without processes aggregate to nothing, and windowSummary leaves the field out", () => {
		const legacy: Tick = { t: 0, hostCpuPct: 1, hostRssBytes: 1, simCpuPct: 0, simRssBytes: 0, hostCpuSec: 0.1 };
		expect(aggregateProcesses([legacy, { ...legacy, t: 500 }], 0, 500)).toEqual([]);
		expect(windowSummary([legacy, { ...legacy, t: 500 }], 0, 500).processes).toBeUndefined();
	});
});
