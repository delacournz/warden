import { describe, expect, test } from "bun:test";
import {
	GOLDEN_PREFIX,
	type GoldenSim,
	goldenKey,
	goldenName,
	isGoldenName,
	isSettled,
	migrationDone,
	parseAllSims,
	parseXcodeBuild,
	planGolden,
	wipName,
} from "./golden";

const inputs = {
	xcodeBuild: "17F113",
	runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
	runtimeBuild: "23F5043",
	deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
};

describe("goldenKey", () => {
	test("10 hex chars, stable, sensitive to every input + recipe", () => {
		const key = goldenKey(inputs);
		expect(key).toMatch(/^[0-9a-f]{10}$/);
		expect(goldenKey(inputs)).toBe(key);
		expect(goldenKey({ ...inputs, xcodeBuild: "17G1" })).not.toBe(key);
		expect(goldenKey({ ...inputs, runtimeBuild: "23F1" })).not.toBe(key);
		expect(goldenKey({ ...inputs, deviceType: "x" })).not.toBe(key);
		expect(goldenKey(inputs, 2)).not.toBe(key);
	});
});

describe("names", () => {
	test("golden + wip names carry profile and key", () => {
		expect(goldenName("iphone-17", "abc123def0")).toBe("warden-golden-iphone-17-abc123def0");
		expect(wipName("iphone-17", "abc123def0")).toBe("warden-golden-iphone-17-abc123def0-wip");
		expect(GOLDEN_PREFIX).toBe("warden-golden");
	});

	test("isGoldenName", () => {
		expect(isGoldenName("warden-golden-iphone-17-abc123def0")).toBe(true);
		expect(isGoldenName("warden-golden-iphone-17-abc123def0-wip")).toBe(true);
		expect(isGoldenName("warden-iphone-17-1")).toBe(false);
	});
});

const sim = (o: Partial<GoldenSim> & { udid: string; name: string }): GoldenSim => ({
	state: "Shutdown",
	isAvailable: true,
	runtimeId: inputs.runtimeId,
	deviceTypeIdentifier: inputs.deviceType,
	...o,
});

describe("planGolden", () => {
	const key = "abc123def0";
	const name = goldenName("iphone-17", key);

	test("reuse the finished golden; other keys of this profile + wips are stale; other profiles untouched", () => {
		const good = sim({ udid: "G", name });
		const old = sim({ udid: "O", name: goldenName("iphone-17", "0000000000") });
		const wip = sim({ udid: "W", name: wipName("iphone-17", key) });
		const otherProfile = sim({ udid: "P", name: goldenName("ipad-air", "1111111111") });
		const pool = sim({ udid: "X", name: "warden-iphone-17-1" });
		expect(planGolden([good, old, wip, otherProfile, pool], "iphone-17", key)).toEqual({
			kind: "reuse",
			sim: good,
			stale: [old, wip],
		});
	});

	test("unavailable golden (runtime removed) is stale → create", () => {
		const gone = sim({ udid: "G", name, isAvailable: false });
		expect(planGolden([gone], "iphone-17", key)).toEqual({ kind: "create", stale: [gone] });
	});

	test("duplicates: keep first", () => {
		const a = sim({ udid: "A", name });
		const b = sim({ udid: "B", name });
		expect(planGolden([a, b], "iphone-17", key)).toEqual({ kind: "reuse", sim: a, stale: [b] });
	});

	test("profile prefix doesn't bleed (iphone-17 vs iphone-17-pro)", () => {
		const pro = sim({ udid: "P", name: goldenName("iphone-17-pro", "2222222222") });
		expect(planGolden([pro], "iphone-17", key)).toEqual({ kind: "create", stale: [] });
	});
});

describe("parsers", () => {
	test("parseXcodeBuild", () => {
		expect(parseXcodeBuild("Xcode 26.6\nBuild version 17F113\n")).toEqual({ success: true, data: "17F113" });
		expect(parseXcodeBuild("nope").success).toBe(false);
	});

	test("parseAllSims keeps unavailable sims + runtime/device type", () => {
		const json = JSON.stringify({
			devices: {
				[inputs.runtimeId]: [
					{ udid: "U1", name: "a", state: "Shutdown", isAvailable: false, deviceTypeIdentifier: inputs.deviceType },
				],
				"com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [{ udid: "W", name: "w", state: "Shutdown" }],
			},
		});
		expect(parseAllSims(json)).toEqual({
			success: true,
			data: [
				{
					udid: "U1",
					name: "a",
					state: "Shutdown",
					isAvailable: false,
					runtimeId: inputs.runtimeId,
					deviceTypeIdentifier: inputs.deviceType,
				},
			],
		});
	});

	test("migrationDone requires success for this runtime build", () => {
		const done = JSON.stringify({ DMLastMigrationResults: { buildVersion: "23F5043", success: true } });
		expect(migrationDone(done, "23F5043")).toBe(true);
		expect(migrationDone(done, "23A1")).toBe(false);
		expect(migrationDone(JSON.stringify({ DMUserDataDisposition: 1 }), "23F5043")).toBe(false);
		expect(migrationDone("", "23F5043")).toBe(false);
		expect(
			migrationDone(JSON.stringify({ DMLastMigrationResults: { buildVersion: "23F5043", success: false } }), "23F5043")
		).toBe(false);
	});

	test("isSettled: last `window` samples all under maxCpu", () => {
		const rule = { maxCpu: 40, window: 3 };
		expect(isSettled([90, 30, 20, 10], rule)).toBe(true);
		expect(isSettled([30, 20], rule)).toBe(false);
		expect(isSettled([10, 50, 10], rule)).toBe(false);
	});
});
