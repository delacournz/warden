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
		ctx.env = { ...ctx.env, WARDEN_CAPACITY_HEADROOM_GB: "8", WARDEN_CAPACITY_MAX: "4" };
		expect(await capacityCommand.run(ctx)).toBe(0);
		const out = JSON.parse(ctx.stdout.join("\n"));
		expect(out.enabled).toBe(true);
		expect(out.budget.maxUnits).toBe(4);
		expect(out.slimCost).toEqual({ ios: { memMb: 1792, cpu: 1 } });
		expect(out.cost).toEqual({ ios: { memMb: 4096, cpu: 1 }, android: { memMb: 4096, cpu: 2 } });
		expect(out.usage.ios).toMatchObject({ booted: 1, warden: 1, foreign: 0, units: 1 });
		expect(out.usage.android.booted).toBe(0);
		expect(out.maxConcurrent.ios).toBeLessThanOrEqual(4);
		expect(out.maxConcurrent.android).toBeLessThanOrEqual(2);
		expect(typeof out.explain).toBe("string");
	});

	test("text output names host, budget and pressure; off is flagged", async () => {
		ctx = testContext([]);
		ctx.env = { ...ctx.env, WARDEN_CAPACITY: "off" };
		expect(await capacityCommand.run(ctx)).toBe(0);
		const text = ctx.stdout.join("\n");
		expect(text).toContain("budget");
		expect(text).toContain("pressure");
		expect(text).toContain("OFF");
	});

	test("a bad override is warned about on stderr and ignored", async () => {
		ctx = testContext(["--json"]);
		ctx.env = { ...ctx.env, WARDEN_CAPACITY_MAX: "lots" };
		expect(await capacityCommand.run(ctx)).toBe(0);
		expect(ctx.stderr.join("\n")).toContain("WARDEN_CAPACITY_MAX=lots");
		expect(JSON.parse(ctx.stdout.join("\n")).budget.maxUnits).toBeNull();
	});
});
