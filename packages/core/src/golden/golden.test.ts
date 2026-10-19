import { describe, expect, test } from "bun:test";
import type { SimctlSim } from "../sims/list";
import {
	GOLDEN_PREFIX,
	GOLDEN_RECIPE,
	goldenKey,
	goldenName,
	isGoldenName,
	isSettled,
	migrationDone,
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
		expect(goldenKey(inputs, GOLDEN_RECIPE + 1)).not.toBe(key);
	});
});

describe("names", () => {
	test("golden + wip names carry profile, key and (from recipe 2) the recipe", () => {
		expect(goldenName("iphone-17", "abc123def0")).toBe(`warden-golden-iphone-17-abc123def0-r${GOLDEN_RECIPE}`);
		expect(wipName("iphone-17", "abc123def0")).toBe(`warden-golden-iphone-17-abc123def0-r${GOLDEN_RECIPE}-wip`);
		expect(goldenName("iphone-17", "abc123def0", 1)).toBe("warden-golden-iphone-17-abc123def0");
		expect(GOLDEN_PREFIX).toBe("warden-golden");
	});

	test("a recipe-1 warden's stale pattern never matches a recipe-2+ golden (ios-claim-path-R4)", () => {
		const recipe1Pattern = /^warden-golden-iphone-17-[0-9a-f]{10}(-wip)?$/;
		expect(recipe1Pattern.test(goldenName("iphone-17", "abc123def0"))).toBe(false);
		expect(recipe1Pattern.test(wipName("iphone-17", "abc123def0"))).toBe(false);
		expect(isGoldenName(goldenName("iphone-17", "abc123def0"))).toBe(true);
	});

	test("isGoldenName", () => {
		expect(isGoldenName("warden-golden-iphone-17-abc123def0")).toBe(true);
		expect(isGoldenName("warden-golden-iphone-17-abc123def0-wip")).toBe(true);
		expect(isGoldenName("warden-iphone-17-1")).toBe(false);
	});
});

const sim = (o: Partial<SimctlSim> & { udid: string; name: string }): SimctlSim => ({
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

	test("never stale: a golden of a newer recipe, or an older-recipe golden passed in keep (ios-claim-path-R4)", () => {
		const good = sim({ udid: "G", name });
		const newer = sim({ udid: "N", name: goldenName("iphone-17", "3333333333", GOLDEN_RECIPE + 1) });
		const newerWip = sim({ udid: "NW", name: wipName("iphone-17", "3333333333", GOLDEN_RECIPE + 1) });
		const legacy = sim({ udid: "L", name: goldenName("iphone-17", "4444444444", 1) });
		const legacyDup = sim({ udid: "L2", name: goldenName("iphone-17", "4444444444", 1) });
		const legacyOther = sim({ udid: "LO", name: goldenName("iphone-17", "5555555555", 1) });
		const plan = planGolden([good, newer, newerWip, legacy, legacyDup, legacyOther], "iphone-17", key, [legacy.name]);
		expect(plan).toEqual({ kind: "reuse", sim: good, stale: [legacyDup, legacyOther] });
		expect(planGolden([good, legacy], "iphone-17", key).stale).toEqual([legacy]);
	});
});

describe("parsers", () => {
	test("parseXcodeBuild", () => {
		expect(parseXcodeBuild("Xcode 26.6\nBuild version 17F113\n")).toEqual({ success: true, data: "17F113" });
		expect(parseXcodeBuild("nope").success).toBe(false);
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
