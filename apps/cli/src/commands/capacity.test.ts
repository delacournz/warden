import { afterEach, describe, expect, test } from "bun:test";
import { fakeSimctl, wardenSim } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { capacityCommand } from "./capacity";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe("warden capacity", () => {
	test("--json: budget, usage by platform (warden vs foreign), costs, max concurrent", async () => {
		ctx = testContext(["--json"], {
			exec: fakeSimctl([wardenSim(1, "Booted"), wardenSim(2)]),
		});
		ctx.env = { ...ctx.env, WARDEN_CAPACITY: "on", WARDEN_CAPACITY_HEADROOM_GB: "8", WARDEN_CAPACITY_MAX: "4" };
		expect(await capacityCommand.run(ctx)).toBe(0);
		const out = JSON.parse(ctx.stdout.join("\n"));
		expect(out.enforced).toBe(true);
		expect(out.budget.maxUnits).toBe(4);
		expect(out.slimCost).toEqual({ ios: { memMb: 1792, cpu: 1 } });
		expect(out.cost).toEqual({ ios: { memMb: 4096, cpu: 1 }, android: { memMb: 4096, cpu: 2 } });
		expect(out.usage.ios).toMatchObject({ booted: 1, warden: 1, foreign: 0, units: 1 });
		expect(out.usage.android.booted).toBe(0);
		expect(out.maxConcurrent.ios).toBeLessThanOrEqual(4);
		expect(out.maxConcurrent.android).toBeLessThanOrEqual(2);
		expect(typeof out.explain).toBe("string");
	});

	test("--json: blocked names the same resource a claim would queue on, and total usage is the shared figure", async () => {
		ctx = testContext(["--json"], {
			exec: fakeSimctl([wardenSim(1, "Booted"), wardenSim(2, "Booted")]),
		});
		ctx.env = { ...ctx.env, WARDEN_CAPACITY: "on", WARDEN_CAPACITY_HEADROOM_GB: "8", WARDEN_CAPACITY_MAX: "1" };
		expect(await capacityCommand.run(ctx)).toBe(0);
		const out = JSON.parse(ctx.stdout.join("\n"));
		expect(out.blocked).toEqual({ ios: "cpu-budget", android: "cpu-budget" });
		expect(out.usage.total.units).toBe(out.usage.ios.units + out.usage.android.units);
	});

	test("--json: at exactly the budget the next boot is blocked, as the claim gate says; with room it is null", async () => {
		ctx = testContext(["--json"], { exec: fakeSimctl([wardenSim(1, "Booted")]) });
		ctx.env = { ...ctx.env, WARDEN_CAPACITY: "on", WARDEN_CAPACITY_HEADROOM_GB: "8", WARDEN_CAPACITY_MAX: "1" };
		expect(await capacityCommand.run(ctx)).toBe(0);
		expect(JSON.parse(ctx.stdout.join("\n")).blocked).toEqual({ ios: "cpu-budget", android: "cpu-budget" });
		ctx.cleanup();
		ctx = testContext(["--json"], { exec: fakeSimctl([wardenSim(1, "Booted")]) });
		ctx.env = { ...ctx.env, WARDEN_CAPACITY: "on", WARDEN_CAPACITY_HEADROOM_GB: "8", WARDEN_CAPACITY_MAX: "2" };
		expect(await capacityCommand.run(ctx)).toBe(0);
		expect(JSON.parse(ctx.stdout.join("\n")).blocked).toEqual({ ios: null, android: "cpu-budget" });
	});

	test("default: numbers are reported but not enforced, and the output says so", async () => {
		ctx = testContext([]);
		expect(await capacityCommand.run(ctx)).toBe(0);
		const text = ctx.stdout.join("\n");
		expect(text).toContain("budget");
		expect(text).toContain("pressure");
		expect(text).toContain("limits not enforced");
		expect(text).toContain("WARDEN_CAPACITY=on");
		ctx.cleanup();
		ctx = testContext(["--json"]);
		expect(await capacityCommand.run(ctx)).toBe(0);
		const out = JSON.parse(ctx.stdout.join("\n"));
		expect(out.enforced).toBe(false);
		expect(out.budget.memMb).toBeGreaterThan(0);
	});

	test("opted in: the text says limits are enforced", async () => {
		ctx = testContext([]);
		ctx.env = { ...ctx.env, WARDEN_CAPACITY: "on" };
		expect(await capacityCommand.run(ctx)).toBe(0);
		const text = ctx.stdout.join("\n");
		expect(text).toContain("limits enforced");
		expect(text).not.toContain("not enforced");
	});

	test("CI with opt-in: headroom is 0, so the whole RAM is budgeted", async () => {
		const small = { totalMem: 7 * 1024 ** 3, perfCores: 3, effCores: 0, os: "darwin" } as const;
		ctx = testContext(["--json"], { hostFacts: async () => small });
		ctx.env = { ...ctx.env, WARDEN_CAPACITY: "on", CI: "true" };
		expect(await capacityCommand.run(ctx)).toBe(0);
		expect(JSON.parse(ctx.stdout.join("\n")).budget.memMb).toBe(7 * 1024);
	});

	test("a bad override is warned about on stderr and ignored", async () => {
		ctx = testContext(["--json"]);
		ctx.env = { ...ctx.env, WARDEN_CAPACITY_MAX: "lots" };
		expect(await capacityCommand.run(ctx)).toBe(0);
		expect(ctx.stderr.join("\n")).toContain("WARDEN_CAPACITY_MAX=lots");
		expect(JSON.parse(ctx.stdout.join("\n")).budget.maxUnits).toBeNull();
	});
});

describe("warden capacity: warm pool", () => {
	const NOW = 10_000_000;
	function seed(c: TestContext) {
		for (const [n, lease] of [
			[1, "l1"],
			[2, "l2"],
		] as const) {
			c.db.recordDevice({ platform: "ios", id: `U${n}`, name: `warden-iphone-17-${n}` }, NOW);
			c.db.recordEvent({
				at: NOW - 1000,
				type: "granted",
				leaseId: lease,
				data: {
					platform: "ios",
					profile: "iphone-17",
					deviceId: `U${n}`,
					deviceName: `n${n}`,
					action: "reuse",
					waitMs: 0,
				},
			});
		}
	}

	test("--json: off by default, no rows", async () => {
		ctx = testContext(["--json"], { exec: fakeSimctl([wardenSim(1)]) });
		expect(await capacityCommand.run(ctx)).toBe(0);
		expect(JSON.parse(ctx.stdout.join("\n")).warm).toEqual({ enabled: false, rows: [] });
	});

	test("--json with WARDEN_WARM=1: target from the 24 h peak vs actual booted", async () => {
		ctx = testContext(["--json"], { now: () => NOW, exec: fakeSimctl([wardenSim(1, "Booted"), wardenSim(2)]) });
		ctx.env = { ...ctx.env, WARDEN_WARM: "1", WARDEN_CAPACITY: "on", WARDEN_CAPACITY_HEADROOM_GB: "8" };
		seed(ctx);
		expect(await capacityCommand.run(ctx)).toBe(0);
		const out = JSON.parse(ctx.stdout.join("\n"));
		expect(out.warm.enabled).toBe(true);
		expect(out.warm.rows).toEqual([{ platform: "ios", profile: "iphone-17", target: 2, actual: 1, peak: 2 }]);
	});

	test("text shows booted/target", async () => {
		ctx = testContext([], { now: () => NOW, exec: fakeSimctl([wardenSim(1, "Booted"), wardenSim(2)]) });
		ctx.env = { ...ctx.env, WARDEN_WARM: "1", WARDEN_CAPACITY: "on", WARDEN_CAPACITY_HEADROOM_GB: "8" };
		seed(ctx);
		expect(await capacityCommand.run(ctx)).toBe(0);
		expect(ctx.stdout.join("\n")).toContain("ios/iphone-17 1/2");
	});
});
