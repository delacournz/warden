import { describe, expect, test } from "bun:test";
import { DEFAULT_COSTS, deviceCost, explain, fits, hostBudget, maxConcurrent, totalCost, ZERO_COST } from "./capacity";
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
		expect(hostBudget(host(16, 8), {}).memMb).toBe(8 * 1024);
		expect(hostBudget(host(24, 8), {}).memMb).toBe(16 * 1024);
	});

	test("headroom is 25% on big hosts", () => {
		expect(hostBudget(host(48, 10), {}).memMb).toBe(36 * 1024);
		expect(hostBudget(host(128, 16), {}).memMb).toBe(96 * 1024);
	});

	test("cpu budget is perfCores x 0.6", () => {
		expect(hostBudget(host(48, 10), {}).cpu).toBeCloseTo(6);
		expect(hostBudget(host(48, 8), {}).cpu).toBeCloseTo(4.8);
	});

	test("headroomGb override replaces the default headroom", () => {
		expect(hostBudget(host(48, 10), { headroomGb: 4 }).memMb).toBe(44 * 1024);
	});

	test("budget never goes negative", () => {
		expect(hostBudget(host(4, 4), {}).memMb).toBe(0);
	});

	test("max is a hard cap on units", () => {
		expect(hostBudget(host(48, 10), { max: 3 }).maxUnits).toBe(3);
		expect(hostBudget(host(48, 10), {}).maxUnits).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("deviceCost", () => {
	test("defaults: android costs twice an ios sim", () => {
		expect(deviceCost("ios", {})).toEqual({ memMb: 2048, cpu: 1 });
		expect(deviceCost("android", {})).toEqual({ memMb: 4096, cpu: 2 });
		expect(DEFAULT_COSTS.ios.cpu).toBe(1);
	});

	test("override merges per platform and field", () => {
		const config = { cost: { android: { memMb: 6000 } } };
		expect(deviceCost("android", config)).toEqual({ memMb: 6000, cpu: 2 });
		expect(deviceCost("ios", config)).toEqual({ memMb: 2048, cpu: 1 });
	});
});

describe("maxConcurrent", () => {
	test.each([
		// gb, perfCores, ios, android
		[16, 8, 4, 2], // mem binds: 8 GB / 2 GB, 8 GB / 4 GB
		[24, 8, 4, 2], // cpu binds: 4.8 units
		[48, 10, 6, 3], // this Mac: cpu binds
		[48, 14, 8, 4],
		[128, 8, 4, 2],
		[128, 16, 9, 4],
	] as const)("%i GB / %i perf cores -> %i ios, %i android", (gb, cores, ios, android) => {
		const budget = hostBudget(host(gb, cores), {});
		expect(maxConcurrent("ios", budget, {})).toBe(ios);
		expect(maxConcurrent("android", budget, {})).toBe(android);
	});

	test("max override caps units", () => {
		const budget = hostBudget(host(128, 16), { max: 4 });
		expect(maxConcurrent("ios", budget, { max: 4 })).toBe(4);
		expect(maxConcurrent("android", budget, { max: 4 })).toBe(2);
	});

	test("never negative or fractional on a starved host", () => {
		expect(maxConcurrent("android", hostBudget(host(4, 4), {}), {})).toBe(0);
	});
});

describe("fits", () => {
	const budget = hostBudget(host(48, 10), {});

	test("empty host admits one of each", () => {
		const result = fits(ZERO_COST, deviceCost("android", {}), budget);
		expect(result.fits).toBe(true);
	});

	test("6 ios fit, the 7th is cpu-bound", () => {
		const six = totalCost(Array(6).fill("ios"), {});
		expect(fits(ZERO_COST, six, budget).fits).toBe(true);
		const seventh = fits(six, deviceCost("ios", {}), budget);
		expect(seventh).toMatchObject({ fits: false, binding: "cpu" });
	});

	test("mixed: 4 ios + 1 android fit, one more ios does not", () => {
		const used = totalCost(["ios", "ios", "ios", "ios", "android"], {});
		expect(fits(ZERO_COST, used, budget).fits).toBe(true);
		expect(fits(used, deviceCost("ios", {}), budget).fits).toBe(false);
	});

	test("mem can bind on a small host", () => {
		const small = hostBudget(host(16, 16), {});
		const used = totalCost(["android", "android"], {});
		expect(fits(used, deviceCost("ios", {}), small)).toMatchObject({ fits: false, binding: "mem" });
	});

	test("max can bind", () => {
		const capped = hostBudget(host(128, 16), { max: 2 });
		expect(fits(totalCost(["ios", "ios"], {}), deviceCost("ios", {}), capped)).toMatchObject({
			fits: false,
			binding: "max",
		});
	});

	test("exactly filling the budget fits (float tolerance)", () => {
		const b = hostBudget(host(48, 14), {});
		expect(fits(totalCost(Array(8).fill("ios"), {}), ZERO_COST, b).fits).toBe(true);
	});

	test("reports remaining on success", () => {
		const result = fits(deviceCost("ios", {}), deviceCost("ios", {}), budget);
		expect(result).toMatchObject({ fits: true });
		if (result.fits) expect(result.remaining.cpu).toBeCloseTo(4);
	});
});

describe("explain", () => {
	const budget = hostBudget(host(48, 10), {});

	test("names the binding dimension and numbers", () => {
		const six = totalCost(Array(6).fill("ios"), {});
		const text = explain(fits(six, deviceCost("ios", {}), budget), six, budget);
		expect(text).toContain("cpu");
		expect(text).toContain("6.0");
	});

	test("fits case says so", () => {
		expect(explain(fits(ZERO_COST, deviceCost("ios", {}), budget), ZERO_COST, budget)).toContain("fits");
	});
});
