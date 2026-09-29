import { afterEach, describe, expect, test } from "bun:test";
import { AUTO_GC_INTERVAL_MS, maybeAutoGc } from "./autogc";
import { type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe("maybeAutoGc", () => {
	test("spawns `gc --quiet` at most once per interval (shared across processes via the store)", () => {
		let clock = 5 * AUTO_GC_INTERVAL_MS;
		ctx = testContext([], { now: () => clock });
		ctx.env = { ...ctx.env, WARDEN_AUTO_GC: "1" };
		const spawned: string[][] = [];
		const spawn = (cmd: string[]) => spawned.push(cmd);
		maybeAutoGc(ctx, ["warden"], spawn);
		maybeAutoGc(ctx, ["warden"], spawn);
		clock += AUTO_GC_INTERVAL_MS;
		maybeAutoGc(ctx, ["warden"], spawn);
		expect(spawned).toEqual([
			["warden", "gc", "--quiet"],
			["warden", "gc", "--quiet"],
		]);
	});

	test("WARDEN_AUTO_GC=0 disables", () => {
		ctx = testContext([]);
		ctx.env = { ...ctx.env, WARDEN_AUTO_GC: "0" };
		const spawned: string[][] = [];
		maybeAutoGc(ctx, ["warden"], (cmd) => spawned.push(cmd));
		expect(spawned).toEqual([]);
	});
});
