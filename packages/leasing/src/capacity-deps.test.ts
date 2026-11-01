import { afterEach, describe, expect, test } from "bun:test";
import { OWNER_ENV, simctlFakes } from "@delacour/warden-providers/testing/simctl.testing";
import { CapacityDepsBuilder, capacityEnv } from "./capacity-deps";
import { ownerResolver } from "./owner";
import { leaseHostFixture, TEST_HOST_FACTS, type TestLeaseHost } from "./testing/lease-host.testing";

let ctx: TestLeaseHost | undefined;
afterEach(() => ctx?.cleanup());

describe("capacityEnabled", () => {
	test.each([
		[undefined, true],
		["on", true],
		["off", false],
		["0", false],
		["FALSE", false],
	])("WARDEN_CAPACITY=%s -> %p", (value, expected) => {
		expect(capacityEnv.enabled({ WARDEN_CAPACITY: value })).toBe(expected);
	});
});

describe("capacityConfigFromEnv", () => {
	test("reads max and headroom", () => {
		expect(capacityEnv.configFromEnv({ WARDEN_CAPACITY_MAX: "6", WARDEN_CAPACITY_HEADROOM_GB: "12" })).toEqual({
			config: { max: 6, headroomGb: 12 },
			problems: [],
		});
	});

	test("zero headroom is allowed; zero max and junk are reported and skipped", () => {
		expect(capacityEnv.configFromEnv({ WARDEN_CAPACITY_HEADROOM_GB: "0" }).config).toEqual({ headroomGb: 0 });
		const bad = capacityEnv.configFromEnv({ WARDEN_CAPACITY_MAX: "0", WARDEN_CAPACITY_HEADROOM_GB: "x" });
		expect(bad.config).toEqual({});
		expect(bad.problems).toHaveLength(2);
	});
});

describe("buildCapacityDeps", () => {
	test("off -> undefined", async () => {
		ctx = leaseHostFixture.build();
		ctx.env = { ...ctx.env, ...OWNER_ENV, WARDEN_CAPACITY: "off" };
		expect(await new CapacityDepsBuilder(ctx).build(ownerResolver.resolve(ctx))).toBeUndefined();
	});

	test("host inventory merges both platforms; a missing toolchain is an empty list", async () => {
		ctx = leaseHostFixture.build({ exec: simctlFakes.build([simctlFakes.wardenSim(1, "Booted")]) });
		ctx.env = { ...ctx.env, ...OWNER_ENV };
		const deps = await new CapacityDepsBuilder(ctx).build(ownerResolver.resolve(ctx));
		const inventory = await deps?.hostInventory();
		expect(inventory?.success && inventory.data.map((d) => d.platform)).toEqual(["ios"]);
		expect(deps?.budget.cpu).toBeGreaterThan(0);
		expect(deps?.shutdownIdle).toBeDefined();
	});
});

describe("readCapacityBasis", () => {
	test("tests get a fixed roomy host, not the machine running them", async () => {
		ctx = leaseHostFixture.build();
		const { host, budget } = await new CapacityDepsBuilder(ctx).basis();
		expect(host).toEqual(TEST_HOST_FACTS);
		expect(budget.cpu).toBeCloseTo(12);
	});

	test("host.hostFacts is the host it budgets", async () => {
		const small = { totalMem: 16 * 1024 ** 3, perfCores: 4, effCores: 4, os: "linux" } as const;
		ctx = leaseHostFixture.build({ hostFacts: async () => small });
		const { host, budget } = await new CapacityDepsBuilder(ctx).basis();
		expect(host).toEqual(small);
		expect(budget.cpu).toBeCloseTo(2.4);
	});
});
