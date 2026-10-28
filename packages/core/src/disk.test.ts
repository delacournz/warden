import { describe, expect, test } from "bun:test";
import {
	type DiskFacts,
	diskThresholds,
	judgeDisk,
	parseBoottime,
	parseDf,
	parseLinuxSwap,
	parseLinuxUptime,
	parseMacSwap,
	parseSnapshots,
	readDiskFacts,
} from "./disk";
import type { Exec, ExecResult } from "./exec";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DAY_MS = 86_400_000;

/** Fake runner: first prefix that matches the command wins; anything else is exit 127. */
function fakeExec(replies: Record<string, Partial<ExecResult>>): Exec {
	return async (cmd) => {
		const key = Object.keys(replies).find((k) => cmd.join(" ").startsWith(k));
		if (key === undefined) return { exitCode: 127, stdout: "", stderr: "not found" };
		return { exitCode: 0, stdout: "", stderr: "", ...replies[key] };
	};
}

const DF = `Filesystem   1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s5   971350180 890000000  52428800    95%    /System/Volumes/Data
`;

describe("parsers", () => {
	test("df -Pk: free and total in bytes", () => {
		expect(parseDf(DF)).toEqual({ freeBytes: 52428800 * 1024, totalBytes: 971350180 * 1024 });
	});

	test("df garbage is undefined", () => {
		expect(parseDf("nope")).toBeUndefined();
	});

	test("macOS vm.swapusage reads used in M and G", () => {
		expect(parseMacSwap("total = 2048.00M  used = 1536.25M  free = 511.75M  (encrypted)")).toBe(
			Math.round(1536.25 * MB)
		);
		expect(parseMacSwap("total = 20.00G  used = 17.50G  free = 2.50G  (encrypted)")).toBe(Math.round(17.5 * GB));
		expect(parseMacSwap("")).toBeUndefined();
	});

	test("linux swap = SwapTotal - SwapFree", () => {
		expect(parseLinuxSwap("MemTotal: 100 kB\nSwapTotal:  8388608 kB\nSwapFree:   4194304 kB\n")).toBe(4 * GB);
		expect(parseLinuxSwap("MemTotal: 100 kB\n")).toBeUndefined();
	});

	test("tmutil snapshots split into os-update and Time Machine", () => {
		const out = `Snapshots for disk /:
com.apple.TimeMachine.2026-10-27-101010.local
com.apple.TimeMachine.2026-10-28-101010.local
com.apple.os.update-0A1B2C3D4E5F
`;
		expect(parseSnapshots(out)).toEqual({ osUpdate: 1, timeMachine: 2 });
		expect(parseSnapshots("Snapshots for disk /:\n")).toEqual({ osUpdate: 0, timeMachine: 0 });
	});

	test("kern.boottime sec", () => {
		expect(parseBoottime("{ sec = 1761600000, usec = 123 } Tue Oct 28 10:00:00 2026")).toBe(1761600000 * 1000);
		expect(parseBoottime("")).toBeUndefined();
	});

	test("/proc/uptime seconds", () => {
		expect(parseLinuxUptime("86400.55 1234.00\n")).toBe(86400.55 * 1000);
		expect(parseLinuxUptime("")).toBeUndefined();
	});
});

describe("readDiskFacts", () => {
	const now = 1761600000 * 1000 + 9 * DAY_MS;

	test("macOS reads every probe", async () => {
		const exec = fakeExec({
			"df -Pk": { stdout: DF },
			"sysctl -n vm.swapusage": { stdout: "total = 20.00G  used = 17.00G  free = 3.00G  (encrypted)" },
			"tmutil listlocalsnapshots": { stdout: "com.apple.os.update-ABC\n" },
			"sysctl -n kern.boottime": { stdout: "{ sec = 1761600000, usec = 0 } x" },
		});
		expect(await readDiskFacts(exec, { os: "darwin", home: "/Users/me", now })).toEqual({
			freeBytes: 52428800 * 1024,
			totalBytes: 971350180 * 1024,
			swapUsedBytes: 17 * GB,
			snapshots: { osUpdate: 1, timeMachine: 0 },
			uptimeDays: 9,
		});
	});

	test("linux reads /proc and has no snapshots probe", async () => {
		const exec = fakeExec({
			"df -Pk": { stdout: DF },
			"cat /proc/meminfo": { stdout: "SwapTotal: 0 kB\nSwapFree: 0 kB\n" },
			"cat /proc/uptime": { stdout: `${2 * 86400}.0 1.0\n` },
		});
		expect(await readDiskFacts(exec, { os: "linux", home: "/home/me", now })).toEqual({
			freeBytes: 52428800 * 1024,
			totalBytes: 971350180 * 1024,
			swapUsedBytes: 0,
			uptimeDays: 2,
		});
	});

	test("a failing probe leaves its field out, never throws", async () => {
		const exec: Exec = async (cmd) => {
			if (cmd[0] === "df") throw new Error("boom");
			return { exitCode: 1, stdout: "", stderr: "" };
		};
		expect(await readDiskFacts(exec, { os: "darwin", home: "/Users/me", now })).toEqual({});
	});
});

describe("diskThresholds", () => {
	test("defaults: max(20 GB, 10%) floor, max(8 GB, 4%) critical, 8 GB swap", () => {
		expect(diskThresholds(500 * GB, {})).toEqual({
			floorBytes: 50 * GB,
			criticalBytes: 20 * GB,
			swapWarnBytes: 8 * GB,
		});
		expect(diskThresholds(100 * GB, {})).toEqual({ floorBytes: 20 * GB, criticalBytes: 8 * GB, swapWarnBytes: 8 * GB });
	});

	test("unknown total uses the absolute minimums", () => {
		expect(diskThresholds(undefined, {})).toEqual({
			floorBytes: 20 * GB,
			criticalBytes: 8 * GB,
			swapWarnBytes: 8 * GB,
		});
	});

	test("config overrides; critical never above floor", () => {
		expect(diskThresholds(500 * GB, { floorGb: 30, criticalGb: 10, swapWarnGb: 4 })).toEqual({
			floorBytes: 30 * GB,
			criticalBytes: 10 * GB,
			swapWarnBytes: 4 * GB,
		});
		expect(diskThresholds(500 * GB, { floorGb: 5 })).toEqual({
			floorBytes: 5 * GB,
			criticalBytes: 5 * GB,
			swapWarnBytes: 8 * GB,
		});
	});
});

describe("judgeDisk", () => {
	const healthy: DiskFacts = {
		freeBytes: 200 * GB,
		totalBytes: 1000 * GB,
		swapUsedBytes: 1 * GB,
		snapshots: { osUpdate: 0, timeMachine: 0 },
		uptimeDays: 1,
	};

	test("healthy host is ok with no reasons", () => {
		expect(judgeDisk(healthy, {})).toEqual({ level: "ok", reasons: [] });
	});

	test("free under floor warns, under critical is critical", () => {
		expect(judgeDisk({ ...healthy, freeBytes: 50 * GB }, {})).toEqual({
			level: "warn",
			reasons: [{ kind: "low-free", freeBytes: 50 * GB, floorBytes: 100 * GB, criticalBytes: 40 * GB }],
		});
		expect(judgeDisk({ ...healthy, freeBytes: 2 * GB }, {}).level).toBe("critical");
	});

	test("swap, snapshots and uptime warn; memory reasons first", () => {
		const verdict = judgeDisk(
			{ ...healthy, swapUsedBytes: 17 * GB, snapshots: { osUpdate: 2, timeMachine: 3 }, uptimeDays: 12 },
			{}
		);
		expect(verdict.level).toBe("warn");
		expect(verdict.reasons.map((r) => r.kind)).toEqual(["swap", "os-update-snapshots", "tm-snapshots", "uptime"]);
	});

	test("unknown facts are not reasons", () => {
		expect(judgeDisk({}, {})).toEqual({ level: "ok", reasons: [] });
	});
});
