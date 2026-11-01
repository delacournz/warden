import { describe, expect, test } from "bun:test";
import { capacityMath, DEFAULT_COSTS, SLIM_IOS_MEM_MB, ZERO_COST } from "./capacity";
import type { HostFacts } from "./host";

const GB = 1024 ** 3;
const host = (gb: number, perfCores: number): HostFacts => ({
	totalMem: gb * GB,
	perfCores,
	effCores: 4,
	os: "darwin",
});

describe("hostBudget", () => {
	test("headroom is 8 GB on small hosts", () => {
		expect(capacityMath.hostBudget(host(16, 8), {}).memMb).toBe(8 * 1024);
		expect(capacityMath.hostBudget(host(24, 8), {}).memMb).toBe(16 * 1024);
	});

	test("headroom is 25% on big hosts", () => {
		expect(capacityMath.hostBudget(host(48, 10), {}).memMb).toBe(36 * 1024);
		expect(capacityMath.hostBudget(host(128, 16), {}).memMb).toBe(96 * 1024);
	});

	test("cpu budget is perfCores x 0.6", () => {
		expect(capacityMath.hostBudget(host(48, 10), {}).cpu).toBeCloseTo(6);
		expect(capacityMath.hostBudget(host(48, 8), {}).cpu).toBeCloseTo(4.8);
	});

	test("headroomGb override replaces the default headroom", () => {
		expect(capacityMath.hostBudget(host(48, 10), { headroomGb: 4 }).memMb).toBe(44 * 1024);
	});

	test("budget never goes negative", () => {
		expect(capacityMath.hostBudget(host(4, 4), {}).memMb).toBe(0);
	});

	test("max is a hard cap on units", () => {
		expect(capacityMath.hostBudget(host(48, 10), { max: 3 }).maxUnits).toBe(3);
		expect(capacityMath.hostBudget(host(48, 10), {}).maxUnits).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("deviceCost", () => {
	test("defaults: android costs twice an ios sim", () => {
		expect(capacityMath.deviceCost("ios", {})).toEqual({ memMb: 4096, cpu: 1 });
		expect(capacityMath.deviceCost("android", {})).toEqual({ memMb: 4096, cpu: 2 });
		expect(DEFAULT_COSTS.ios.cpu).toBe(1);
	});

	test("override merges per platform and field", () => {
		const config = { cost: { android: { memMb: 6000 } } };
		expect(capacityMath.deviceCost("android", config)).toEqual({ memMb: 6000, cpu: 2 });
		expect(capacityMath.deviceCost("ios", config)).toEqual({ memMb: 4096, cpu: 1 });
	});
});

describe("maxConcurrent", () => {
	test.each([
		// gb, perfCores, ios, android
		[16, 8, 2, 2], // mem binds: 8 GB / 4 GB either way
		[24, 8, 4, 2], // cpu binds: 4.8 units
		[48, 10, 6, 3], // this Mac: cpu binds
		[48, 14, 8, 4],
		[128, 8, 4, 2],
		[128, 16, 9, 4],
	] as const)("%i GB / %i perf cores -> %i ios, %i android", (gb, cores, ios, android) => {
		const budget = capacityMath.hostBudget(host(gb, cores), {});
		expect(capacityMath.maxConcurrent("ios", budget, {})).toBe(ios);
		expect(capacityMath.maxConcurrent("android", budget, {})).toBe(android);
	});

	test("max override caps units", () => {
		const budget = capacityMath.hostBudget(host(128, 16), { max: 4 });
		expect(capacityMath.maxConcurrent("ios", budget, { max: 4 })).toBe(4);
		expect(capacityMath.maxConcurrent("android", budget, { max: 4 })).toBe(2);
	});

	test("never negative or fractional on a starved host", () => {
		expect(capacityMath.maxConcurrent("android", capacityMath.hostBudget(host(4, 4), {}), {})).toBe(0);
	});
});

describe("fits", () => {
	const budget = capacityMath.hostBudget(host(48, 10), {});

	test("empty host admits one of each", () => {
		const result = capacityMath.fits(ZERO_COST, capacityMath.deviceCost("android", {}), budget);
		expect(result.fits).toBe(true);
	});

	test("6 ios fit, the 7th is cpu-bound", () => {
		const six = capacityMath.totalCost(Array(6).fill("ios"), {});
		expect(capacityMath.fits(ZERO_COST, six, budget).fits).toBe(true);
		const seventh = capacityMath.fits(six, capacityMath.deviceCost("ios", {}), budget);
		expect(seventh).toMatchObject({ fits: false, binding: "cpu" });
	});

	test("mixed: 4 ios + 1 android fit, one more ios does not", () => {
		const used = capacityMath.totalCost(["ios", "ios", "ios", "ios", "android"], {});
		expect(capacityMath.fits(ZERO_COST, used, budget).fits).toBe(true);
		expect(capacityMath.fits(used, capacityMath.deviceCost("ios", {}), budget).fits).toBe(false);
	});

	test("mem can bind on a small host", () => {
		const small = capacityMath.hostBudget(host(16, 16), {});
		const used = capacityMath.totalCost(["android", "android"], {});
		expect(capacityMath.fits(used, capacityMath.deviceCost("ios", {}), small)).toMatchObject({
			fits: false,
			binding: "mem",
		});
	});

	test("max can bind", () => {
		const capped = capacityMath.hostBudget(host(128, 16), { max: 2 });
		expect(
			capacityMath.fits(capacityMath.totalCost(["ios", "ios"], {}), capacityMath.deviceCost("ios", {}), capped)
		).toMatchObject({
			fits: false,
			binding: "max",
		});
	});

	test("exactly filling the budget capacityMath.fits(float tolerance)", () => {
		const b = capacityMath.hostBudget(host(48, 14), {});
		expect(capacityMath.fits(capacityMath.totalCost(Array(8).fill("ios"), {}), ZERO_COST, b).fits).toBe(true);
	});

	test("reports remaining on success", () => {
		const result = capacityMath.fits(capacityMath.deviceCost("ios", {}), capacityMath.deviceCost("ios", {}), budget);
		expect(result).toMatchObject({ fits: true });
		if (result.fits) expect(result.remaining.cpu).toBeCloseTo(4);
	});
});

describe("explain", () => {
	const budget = capacityMath.hostBudget(host(48, 10), {});

	test("names the binding dimension and numbers", () => {
		const six = capacityMath.totalCost(Array(6).fill("ios"), {});
		const text = capacityMath.explain(capacityMath.fits(six, capacityMath.deviceCost("ios", {}), budget), six, budget);
		expect(text).toContain("cpu");
		expect(text).toContain("6.0");
	});

	test("fits case says so", () => {
		expect(
			capacityMath.explain(capacityMath.fits(ZERO_COST, capacityMath.deviceCost("ios", {}), budget), ZERO_COST, budget)
		).toContain("fits");
	});
});

describe("slim cost", () => {
	test("slim ios sim costs SLIM_IOS_MEM_MB, stock stays 4096", () => {
		expect(DEFAULT_COSTS.ios.memMb).toBe(4096);
		expect(capacityMath.deviceCost("ios", {}, { slim: true })).toEqual({ memMb: SLIM_IOS_MEM_MB, cpu: 1 });
		expect(capacityMath.deviceCost("ios", {}, { slim: false }).memMb).toBe(4096);
	});

	test("android ignores slim", () => {
		expect(capacityMath.deviceCost("android", {}, { slim: true })).toEqual({ memMb: 4096, cpu: 2 });
	});

	test("cost.ios.slimMemMb overrides the slim figure only", () => {
		const config = { cost: { ios: { slimMemMb: 900 } } };
		expect(capacityMath.deviceCost("ios", config, { slim: true }).memMb).toBe(900);
		expect(capacityMath.deviceCost("ios", config).memMb).toBe(4096);
	});

	test("cost.ios.memMb overrides stock, not slim", () => {
		const config = { cost: { ios: { memMb: 3000 } } };
		expect(capacityMath.deviceCost("ios", config).memMb).toBe(3000);
		expect(capacityMath.deviceCost("ios", config, { slim: true }).memMb).toBe(SLIM_IOS_MEM_MB);
	});

	test("totalCost applies per-device slim flags", () => {
		const total = capacityMath.totalCost(["ios", "ios", "android"], {}, [true, false, true]);
		expect(total.memMb).toBe(SLIM_IOS_MEM_MB + 4096 + 4096);
		expect(capacityMath.totalCost(["ios", "ios"], {}).memMb).toBe(8192);
	});
});
