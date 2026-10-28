import { describe, expect, test } from "bun:test";
import { buildDiskGate, diskConfigFromEnv, diskGateEnabled } from "./disk-deps";
import { testContext } from "./testing";

describe("diskGateEnabled", () => {
	test.each([
		[undefined, true],
		["on", true],
		["off", false],
		["0", false],
		["FALSE", false],
		[" no ", false],
	])("WARDEN_DISK=%s -> %p", (value, expected) => {
		expect(diskGateEnabled({ WARDEN_DISK: value })).toBe(expected);
	});
});

describe("diskConfigFromEnv", () => {
	test("reads floor, critical and swap warn", () => {
		expect(
			diskConfigFromEnv({
				WARDEN_DISK_FLOOR_GB: "30",
				WARDEN_DISK_CRITICAL_GB: "10",
				WARDEN_DISK_SWAP_WARN_GB: "4",
			})
		).toEqual({ config: { floorGb: 30, criticalGb: 10, swapWarnGb: 4 }, problems: [] });
	});

	test("nothing set -> empty config", () => {
		expect(diskConfigFromEnv({})).toEqual({ config: {}, problems: [] });
	});

	test("zero swap warn is allowed; zero floor and junk are reported and skipped", () => {
		const result = diskConfigFromEnv({
			WARDEN_DISK_FLOOR_GB: "0",
			WARDEN_DISK_CRITICAL_GB: "lots",
			WARDEN_DISK_SWAP_WARN_GB: "0",
		});
		expect(result.config).toEqual({ swapWarnGb: 0 });
		expect(result.problems).toHaveLength(2);
		expect(result.problems[0]).toContain("WARDEN_DISK_FLOOR_GB=0");
		expect(result.problems[1]).toContain("WARDEN_DISK_CRITICAL_GB=lots");
	});
});

describe("buildDiskGate", () => {
	const DF = "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/d 500000000 494000000 6000000 99% /";
	const dfExec = (calls: string[][]) => async (cmd: readonly string[]) => {
		calls.push([...cmd]);
		return { exitCode: cmd[0] === "df" ? 0 : 1, stdout: cmd[0] === "df" ? DF : "", stderr: "" };
	};

	test("is undefined when WARDEN_DISK=off", () => {
		const ctx = testContext(["claim"]);
		ctx.env.WARDEN_DISK = "off";
		expect(buildDiskGate(ctx, "other")).toBeUndefined();
		ctx.cleanup();
	});

	test("judges the df read and caches it for a few seconds", async () => {
		const calls: string[][] = [];
		let now = 1_000_000;
		const ctx = testContext(["claim"], { exec: dfExec(calls), now: () => now });
		const gate = buildDiskGate(ctx, "other");
		const first = await gate?.verdict();
		expect(first?.success && first.data.level).toBe("critical");
		now += 5_000;
		await gate?.verdict();
		expect(calls.filter((c) => c[0] === "df")).toHaveLength(1);
		now += 20_000;
		await gate?.verdict();
		expect(calls.filter((c) => c[0] === "df")).toHaveLength(2);
		ctx.cleanup();
	});
});
