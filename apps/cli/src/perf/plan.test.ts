import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, testContext } from "../testing";
import { sessionDir } from "./paths";
import { type PerfPlan, readPlan, updatePlan, writePlan } from "./plan";

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
		writePlan(c, "s1", plan);
		expect(readPlan(c, "s1")).toEqual(plan);
		expect(updatePlan(c, "s1", (p) => ({ ...p, leaseId: "L1" }))?.leaseId).toBe("L1");
		expect(readPlan(c, "s1")?.leaseId).toBe("L1");
	});

	test("missing, malformed or wrong-shape files read as undefined", () => {
		const c = testContext([]);
		ctx = c;
		expect(readPlan(c, "none")).toBeUndefined();
		expect(updatePlan(c, "none", (p) => p)).toBeUndefined();
		mkdirSync(sessionDir(c, "bad"), { recursive: true });
		writeFileSync(join(sessionDir(c, "bad"), "plan.json"), "{nope");
		expect(readPlan(c, "bad")).toBeUndefined();
		writeFileSync(join(sessionDir(c, "bad"), "plan.json"), JSON.stringify({ version: 2 }));
		expect(readPlan(c, "bad")).toBeUndefined();
	});
});
