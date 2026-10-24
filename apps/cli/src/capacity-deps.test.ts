import { afterEach, describe, expect, test } from "bun:test";
import { buildCapacityDeps, capacityConfigFromEnv, capacityEnabled, readCapacityBasis } from "./capacity-deps";
import { resolveOwner } from "./claim-flags";
import { fakeSimctl, OWNER_ENV, wardenSim } from "./simctl.testing";
import { TEST_HOST, type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe("capacityEnabled", () => {
	test.each([
		[undefined, true],
		["on", true],
		["off", false],
		["0", false],
		["FALSE", false],
	])("WARDEN_CAPACITY=%s -> %p", (value, expected) => {
		expect(capacityEnabled({ WARDEN_CAPACITY: value })).toBe(expected);
	});
});

describe("capacityConfigFromEnv", () => {
	test("reads max and headroom", () => {
		expect(capacityConfigFromEnv({ WARDEN_CAPACITY_MAX: "6", WARDEN_CAPACITY_HEADROOM_GB: "12" })).toEqual({
			config: { max: 6, headroomGb: 12 },
			problems: [],
		});
	});

	test("zero headroom is allowed; zero max and junk are reported and skipped", () => {
		expect(capacityConfigFromEnv({ WARDEN_CAPACITY_HEADROOM_GB: "0" }).config).toEqual({ headroomGb: 0 });
		const bad = capacityConfigFromEnv({ WARDEN_CAPACITY_MAX: "0", WARDEN_CAPACITY_HEADROOM_GB: "x" });
		expect(bad.config).toEqual({});
		expect(bad.problems).toHaveLength(2);
	});
});

describe("buildCapacityDeps", () => {
	test("off -> undefined", async () => {
		ctx = testContext([]);
		ctx.env = { ...ctx.env, ...OWNER_ENV, WARDEN_CAPACITY: "off" };
		expect(await buildCapacityDeps(ctx, resolveOwner(ctx))).toBeUndefined();
	});

	test("host inventory merges both platforms; a missing toolchain is an empty list", async () => {
		ctx = testContext([], { exec: fakeSimctl([wardenSim(1, "Booted")]) });
		ctx.env = { ...ctx.env, ...OWNER_ENV };
		const deps = await buildCapacityDeps(ctx, resolveOwner(ctx));
		const inventory = await deps?.hostInventory();
		expect(inventory?.success && inventory.data.map((d) => d.platform)).toEqual(["ios"]);
		expect(deps?.budget.cpu).toBeGreaterThan(0);
		expect(deps?.shutdownIdle).toBeDefined();
	});
});

describe("readCapacityBasis", () => {
	test("tests get a fixed roomy host, not the machine running them", async () => {
		ctx = testContext([]);
		const { host, budget } = await readCapacityBasis(ctx);
		expect(host).toEqual(TEST_HOST);
		expect(budget.cpu).toBeCloseTo(12);
	});

	test("ctx.hostFacts is the host it budgets", async () => {
		const small = { totalMem: 16 * 1024 ** 3, perfCores: 4, effCores: 4, os: "linux" } as const;
		ctx = testContext([], { hostFacts: async () => small });
		const { host, budget } = await readCapacityBasis(ctx);
		expect(host).toEqual(small);
		expect(budget.cpu).toBeCloseTo(2.4);
	});
});
