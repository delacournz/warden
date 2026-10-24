import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "./exec";
import { memoryPressure, readHostFacts } from "./host";

const GB = 1024 ** 3;
const osFacts = { totalMem: 8 * GB, cores: 4 };

/** Fake runner: first prefix that matches the command wins; anything else is exit 127. */
function fakeExec(replies: Record<string, Partial<ExecResult>>): Exec {
	return async (cmd) => {
		const key = Object.keys(replies).find((k) => cmd.join(" ").startsWith(k));
		if (key === undefined) return { exitCode: 127, stdout: "", stderr: "not found" };
		return { exitCode: 0, stdout: "", stderr: "", ...replies[key] };
	};
}

describe("readHostFacts", () => {
	test("macOS Apple silicon reads memsize + perf/eff cores from sysctl", async () => {
		const exec = fakeExec({ "sysctl -n hw.memsize": { stdout: `${48 * GB}\n10\n4\n` } });
		expect(await readHostFacts(exec, "darwin", osFacts)).toEqual({
			totalMem: 48 * GB,
			perfCores: 10,
			effCores: 4,
			os: "darwin",
		});
	});

	test("macOS without perflevel keys falls back to os core count, eff 0", async () => {
		const exec = fakeExec({ "sysctl -n hw.memsize": { exitCode: 1, stdout: `${16 * GB}\n` } });
		expect(await readHostFacts(exec, "darwin", osFacts)).toEqual({
			totalMem: 16 * GB,
			perfCores: 4,
			effCores: 0,
			os: "darwin",
		});
	});

	test("sysctl missing falls back to os facts", async () => {
		expect(await readHostFacts(fakeExec({}), "darwin", osFacts)).toEqual({
			totalMem: 8 * GB,
			perfCores: 4,
			effCores: 0,
			os: "darwin",
		});
	});

	test("linux uses os facts without running anything", async () => {
		const exec: Exec = async () => {
			throw new Error("should not run");
		};
		expect(await readHostFacts(exec, "linux", osFacts)).toEqual({
			totalMem: 8 * GB,
			perfCores: 4,
			effCores: 0,
			os: "linux",
		});
	});

	test("garbage sysctl output falls back", async () => {
		const exec = fakeExec({ "sysctl -n hw.memsize": { stdout: "nope\n" } });
		expect((await readHostFacts(exec, "darwin", osFacts)).totalMem).toBe(8 * GB);
	});
});

describe("memoryPressure", () => {
	test.each([
		["1", "normal"],
		["2", "warn"],
		["4", "critical"],
	] as const)("macOS sysctl level %s is %s", async (level, expected) => {
		const exec = fakeExec({ "sysctl -n kern.memorystatus_vm_pressure_level": { stdout: `${level}\n` } });
		expect(await memoryPressure(exec, "darwin")).toEqual({ success: true, data: expected });
	});

	test.each([
		[60, "normal"],
		[20, "warn"],
		[5, "critical"],
	] as const)("macOS memory_pressure free %i%% is %s when sysctl fails", async (free, expected) => {
		const exec = fakeExec({
			memory_pressure: { stdout: `The system has 1 pages.\nSystem-wide memory free percentage: ${free}%\n` },
		});
		expect(await memoryPressure(exec, "darwin")).toEqual({ success: true, data: expected });
	});

	test("macOS with nothing readable is an error", async () => {
		const result = await memoryPressure(fakeExec({}), "darwin");
		expect(result.success).toBe(false);
	});

	test.each([
		[8_000_000, "normal"],
		[1_500_000, "warn"],
		[500_000, "critical"],
	] as const)("linux MemAvailable %i kB of 10 GB-ish is %s", async (avail, expected) => {
		const exec = fakeExec({
			"cat /proc/meminfo": { stdout: `MemTotal:       10000000 kB\nMemFree: 1 kB\nMemAvailable:   ${avail} kB\n` },
		});
		expect(await memoryPressure(exec, "linux")).toEqual({ success: true, data: expected });
	});

	test("linux without MemAvailable is an error", async () => {
		const exec = fakeExec({ "cat /proc/meminfo": { stdout: "MemTotal: 1 kB\n" } });
		expect((await memoryPressure(exec, "linux")).success).toBe(false);
	});

	test("other os is an error", async () => {
		expect((await memoryPressure(fakeExec({}), "other")).success).toBe(false);
	});
});
