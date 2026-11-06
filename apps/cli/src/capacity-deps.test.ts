import { afterEach, describe, expect, test } from "bun:test";
import { buildCapacityDeps, capacityConfigFromEnv, capacityEnabled, readCapacityBasis } from "./capacity-deps";
import { resolveOwner } from "./claim-flags";
import { fakeSimctl, OWNER_ENV, wardenSim } from "./simctl.testing";
import { TEST_HOST, type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe("capacityEnabled", () => {
	test.each([
		[undefined, false],
		["", false],
		["off", false],
		["0", false],
		["FALSE", false],
		["banana", false],
		["on", true],
		["ON", true],
		["1", true],
		["true", true],
		["yes", true],
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

	test("CI defaults the headroom to 0; an explicit value still wins", () => {
		expect(capacityConfigFromEnv({ CI: "true" }).config).toEqual({ headroomGb: 0 });
		expect(capacityConfigFromEnv({ CI: "1" }).config).toEqual({ headroomGb: 0 });
		expect(capacityConfigFromEnv({ GITHUB_ACTIONS: "true" }).config).toEqual({ headroomGb: 0 });
		expect(capacityConfigFromEnv({ CI: "true", WARDEN_CAPACITY_HEADROOM_GB: "3" }).config).toEqual({ headroomGb: 3 });
		expect(capacityConfigFromEnv({ CI: "false" }).config).toEqual({});
		expect(capacityConfigFromEnv({}).config).toEqual({});
	});

	test("zero headroom is allowed; zero max and junk are reported and skipped", () => {
		expect(capacityConfigFromEnv({ WARDEN_CAPACITY_HEADROOM_GB: "0" }).config).toEqual({ headroomGb: 0 });
		const bad = capacityConfigFromEnv({ WARDEN_CAPACITY_MAX: "0", WARDEN_CAPACITY_HEADROOM_GB: "x" });
		expect(bad.config).toEqual({});
		expect(bad.problems).toHaveLength(2);
	});
});

describe("buildCapacityDeps", () => {
	test("default and explicit off -> undefined (no gate, no queue)", async () => {
		ctx = testContext([]);
		ctx.env = { ...ctx.env, ...OWNER_ENV };
		expect(await buildCapacityDeps(ctx, resolveOwner(ctx))).toBeUndefined();
		ctx.env = { ...ctx.env, WARDEN_CAPACITY: "off" };
		expect(await buildCapacityDeps(ctx, resolveOwner(ctx))).toBeUndefined();
	});

	test("a low-memory host has no budget in CI until opted in, and then headroom is 0", async () => {
		const small = { totalMem: 7 * 1024 ** 3, perfCores: 3, effCores: 0, os: "darwin" } as const;
		ctx = testContext([], { hostFacts: async () => small });
		ctx.env = { ...ctx.env, ...OWNER_ENV, WARDEN_CAPACITY: "on" };
		expect((await buildCapacityDeps(ctx, resolveOwner(ctx)))?.budget.memMb).toBe(0);
		ctx.env = { ...ctx.env, CI: "true" };
		expect((await buildCapacityDeps(ctx, resolveOwner(ctx)))?.budget.memMb).toBe(7 * 1024);
	});

	test("host inventory merges both platforms; a missing toolchain is an empty list", async () => {
		ctx = testContext([], { exec: fakeSimctl([wardenSim(1, "Booted")]) });
		ctx.env = { ...ctx.env, ...OWNER_ENV, WARDEN_CAPACITY: "on" };
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
