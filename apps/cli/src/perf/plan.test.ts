import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { perfPaths } from "@delacour/warden-sdk/ops/perf/paths";
import { type PerfPlan, perfPlans } from "@delacour/warden-sdk/ops/perf/plan";
import { type TestContext, testContext } from "../testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const plan: PerfPlan = {
	version: 1,
	app: "com.example",
	cwd: "/x",
	metrics: true,
	frames: false,
	logs: true,
	js: false,
	react: false,
	relaunch: false,
};

describe("plan.json", () => {
	test("round-trips and updates", () => {
		const c = testContext([]);
		ctx = c;
		perfPlans.writePlan(c, "s1", plan);
		expect(perfPlans.readPlan(c, "s1")).toEqual(plan);
		expect(perfPlans.updatePlan(c, "s1", (p) => ({ ...p, leaseId: "L1" }))?.leaseId).toBe("L1");
		expect(perfPlans.readPlan(c, "s1")?.leaseId).toBe("L1");
	});

	test("missing, malformed or wrong-shape files read as undefined", () => {
		const c = testContext([]);
		ctx = c;
		expect(perfPlans.readPlan(c, "none")).toBeUndefined();
		expect(perfPlans.updatePlan(c, "none", (p) => p)).toBeUndefined();
		mkdirSync(perfPaths.sessionDir(c, "bad"), { recursive: true });
		writeFileSync(join(perfPaths.sessionDir(c, "bad"), "plan.json"), "{nope");
		expect(perfPlans.readPlan(c, "bad")).toBeUndefined();
		writeFileSync(join(perfPaths.sessionDir(c, "bad"), "plan.json"), JSON.stringify({ version: 2 }));
		expect(perfPlans.readPlan(c, "bad")).toBeUndefined();
	});
});
