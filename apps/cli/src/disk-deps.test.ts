import { describe, expect, test } from "bun:test";
import { diskConfigFromEnv, diskGateEnabled } from "./disk-deps";

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
