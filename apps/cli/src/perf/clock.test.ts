import { afterEach, describe, expect, test } from "bun:test";
import { perfClock } from "@delacour/warden-sdk/ops/perf/clock";
import { type TestContext, testContext } from "../testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe("readClockOffsetMs", () => {
	test("the iOS simulator shares the host clock", async () => {
		ctx = testContext([]);
		expect(await perfClock.readClockOffsetMs(ctx, { platform: "ios", id: "U" })).toBe(0);
	});

	test("Android: device time minus the midpoint of the round trip", async () => {
		const times = [1_000_000, 1_000_040];
		ctx = testContext([], { now: () => times.shift() ?? 0 });
		ctx.exec = async () => ({ exitCode: 0, stdout: "1000000500000000\n", stderr: "" });
		// device 1_000_000_500 ms vs host midpoint 1_000_020 ms
		expect(await perfClock.readClockOffsetMs(ctx, { platform: "android", id: "emu" })).toBe(1_000_000_500 - 1_000_020);
	});

	test("an unreadable clock is undefined", async () => {
		ctx = testContext([]);
		ctx.exec = async () => ({ exitCode: 1, stdout: "", stderr: "no" });
		expect(await perfClock.readClockOffsetMs(ctx, { platform: "android", id: "emu" })).toBeUndefined();
	});
});
