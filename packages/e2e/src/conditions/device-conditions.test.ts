import { describe, expect, test } from "bun:test";
import type { ClockCondition } from "@delacour/warden-core/conditions/conditions.types";
import { ok } from "@delacour/warden-types/result";
import { type DriverCall, fakeDriver, snapshotOf } from "../driver/driver.testing";
import type { Driver, Platform } from "../driver/driver.types";
import type { E2eEnv } from "../env";
import type { E2eError } from "../errors";
import type { ConditionEvent } from "./condition-events";
import { createDeviceConditions, type DeviceConditions } from "./device-conditions";
import type { TickerClock } from "./route-ticker";

const env: E2eEnv = {
	udid: "UDID",
	platform: "ios",
	bundleId: "com.example.app",
	launchArgs: [],
	out: "/tmp/out",
	timeoutMs: 1000,
	actionTimeoutMs: 1000,
	assertionTimeoutMs: 1000,
	logTimestamps: false,
};

/** a clock whose sleeps only end when the run is stopped, so a test decides when time passes */
function stuckClock(): TickerClock & { time: number } {
	const clock = {
		time: 1_000,
		now: () => clock.time,
		sleep: (ms: number, signal: AbortSignal) =>
			new Promise<void>((resolve) => {
				if (ms <= 0 || signal.aborted) return resolve();
				signal.addEventListener("abort", () => resolve(), { once: true });
			}),
	};
	return clock;
}

function setup(
	opts: { platform?: Platform; conditions?: E2eEnv["conditions"]; clockOp?: boolean; log?: string[] } = {}
): {
	c: DeviceConditions;
	driver: ReturnType<typeof fakeDriver>;
	events: ConditionEvent[];
	clock: ReturnType<typeof stuckClock>;
	ops: ClockCondition[];
} {
	const platform = opts.platform ?? "ios";
	const driver = fakeDriver({ screens: [snapshotOf([], { platform })], platform });
	const ops: ClockCondition[] = [];
	if (opts.clockOp === false) {
		(driver as { clock?: Driver["clock"] }).clock = undefined;
	} else {
		driver.clock = async (op) => {
			ops.push(op);
			return ok({ condition: op, offsetMs: 0, frozen: op.kind === "frozen", nowMs: 0 });
		};
	}
	const events: ConditionEvent[] = [];
	const clock = stuckClock();
	const c = createDeviceConditions({
		driver,
		env: { ...env, platform, ...(opts.conditions === undefined ? {} : { conditions: opts.conditions }) },
		signal: () => undefined,
		sink: (e) => void events.push(e),
		tickerClock: clock,
		log: (line) => void opts.log?.push(line),
	});
	return { c, driver, events, clock, ops };
}

const networkOps = (calls: readonly DriverCall[]) =>
	calls.flatMap((call) => (call.method === "network" ? [call.op] : []));

describe("device.network", () => {
	test("set takes a condition or its word", async () => {
		const { c, driver } = setup();
		await c.network.set("offline");
		await c.network.set("3g");
		await c.network.set({ kind: "custom", latencyMs: 200 });
		expect(networkOps(driver.calls)).toEqual([
			{ kind: "offline" },
			{ kind: "preset", preset: "3g" },
			{ kind: "custom", latencyMs: 200 },
		]);
	});

	test("an unknown word is INVALID_ARGUMENT and touches nothing", async () => {
		const { c, driver } = setup();
		await expect(c.network.set("5g" as "3g")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		expect(networkOps(driver.calls)).toEqual([]);
	});

	test("set passes relaunch to the driver", async () => {
		const { c, driver } = setup();
		await c.network.set("offline", { relaunch: true });
		expect(driver.callsOf("network")[0]).toMatchObject({ op: { kind: "offline" } });
	});

	test("a driver failure is thrown as an E2eError that names what to do", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (call) =>
				call.method === "network"
					? { error: { code: "E_NETWORK_RELAUNCH", message: "running without dylib", retryable: false } }
					: undefined,
		});
		const c = createDeviceConditions({ driver, env, signal: () => undefined, tickerClock: stuckClock() });
		const error = await c.network.set("offline").catch((e: E2eError) => e);
		expect(error).toMatchObject({ code: "ACTION_FAILED" });
		expect((error as E2eError).message).toContain("relaunch: true");
	});

	test("status is the condition in effect, the faults and whether a flap runs", async () => {
		const { c } = setup();
		expect(await c.network.status()).toEqual({ condition: { kind: "online" }, faults: [], flapping: false });
		await c.network.set("lte");
		await c.network.fault({ match: "api.test", action: { kind: "status", code: 503 } });
		expect(await c.network.status()).toEqual({
			condition: { kind: "preset", preset: "lte" },
			faults: [{ match: "api.test", action: { kind: "status", code: 503 } }],
			flapping: false,
		});
	});

	test("fault takes one rule or a list; [] clears", async () => {
		const { c, driver } = setup();
		await c.network.fault({ match: "a", action: { kind: "reset" } });
		await c.network.fault([
			{ match: "b", action: { kind: "blackhole" } },
			{ match: "c", action: { kind: "delay", ms: 5 } },
		]);
		await c.network.fault([]);
		expect(driver.callsOf("networkFaults").map((call) => call.faults.length)).toEqual([1, 2, 0]);
	});

	test("reset goes back to online and clears the faults", async () => {
		const { c, driver } = setup();
		await c.network.set("offline");
		await c.network.fault({ match: "a", action: { kind: "reset" } });
		await c.network.reset();
		expect(networkOps(driver.calls).at(-1)).toEqual({ kind: "online" });
		expect(driver.callsOf("networkFaults").at(-1)?.faults).toEqual([]);
		expect((await c.network.status()).faults).toEqual([]);
	});

	test("every change emits a condition event", async () => {
		const { c, events } = setup();
		await c.network.set("offline");
		await c.network.fault({ match: "a", action: { kind: "reset" } });
		expect(events.map((e) => [e.area, e.type])).toEqual([
			["network", "condition"],
			["faults", "condition"],
		]);
		expect(events[0]).toMatchObject({ value: { kind: "offline" } });
	});
});

describe("device.network.during", () => {
	test("applies the condition for fn and restores the previous one", async () => {
		const { c, driver } = setup();
		await c.network.set("4g");
		const seen = await c.network.during("offline", async () => (await c.network.status()).condition);
		expect(seen).toEqual({ kind: "offline" });
		expect(networkOps(driver.calls)).toEqual([
			{ kind: "preset", preset: "4g" },
			{ kind: "offline" },
			{ kind: "preset", preset: "4g" },
		]);
	});

	test("restores when fn throws, and throws fn's error", async () => {
		const { c, driver } = setup();
		await expect(
			c.network.during("offline", async () => {
				throw new Error("boom");
			})
		).rejects.toThrow("boom");
		expect(networkOps(driver.calls)).toEqual([{ kind: "offline" }, { kind: "online" }]);
		expect((await c.network.status()).condition).toEqual({ kind: "online" });
	});

	test("restores a flap that was running", async () => {
		const { c } = setup();
		await c.network.flap({ up: "10s", down: "2s" });
		await c.network.during("offline", async () => {
			expect((await c.network.status()).flapping).toBe(false);
		});
		expect((await c.network.status()).flapping).toBe(true);
		await c.network.reset();
	});

	test("a failing restore does not hide fn's own error", async () => {
		const log: string[] = [];
		let calls = 0;
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (call) => {
				if (call.method !== "network") return undefined;
				calls += 1;
				return calls === 2 ? { error: { code: "E_IO", message: "adb gone", retryable: false } } : undefined;
			},
		});
		const c = createDeviceConditions({
			driver,
			env,
			signal: () => undefined,
			tickerClock: stuckClock(),
			log: (l) => log.push(l),
		});
		await expect(
			c.network.during("offline", async () => {
				throw new Error("boom");
			})
		).rejects.toThrow("boom");
		expect(log.join("\n")).toContain("adb gone");
	});
});

describe("device.network.flap", () => {
	test("starts up, returns a handle, and stop restores the base", async () => {
		const { c, driver } = setup();
		const run = await c.network.flap({ up: "10s", down: 2000, jitterPct: 10, seed: 3 });
		expect((await c.network.status()).flapping).toBe(true);
		const outcome = await run.stop();
		expect(outcome.stopped).toBe("aborted");
		expect(networkOps(driver.calls).at(-1)).toEqual({ kind: "online" });
		expect((await c.network.status()).flapping).toBe(false);
	});

	test("bad durations are INVALID_ARGUMENT", async () => {
		const { c, driver } = setup();
		await expect(c.network.flap({ up: "soon", down: "1s" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		await expect(c.network.flap({ up: "1s", down: 0 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		expect(networkOps(driver.calls)).toEqual([]);
	});

	test("a set while flapping stops the flap first", async () => {
		const { c } = setup();
		const run = await c.network.flap({ up: "10s", down: "1s" });
		await c.network.set("offline");
		expect(run.status().state).toBe("stopped");
		expect((await c.network.status()).flapping).toBe(false);
	});

	test("set with a flap condition starts one", async () => {
		const { c } = setup();
		await c.network.set({ kind: "flap", upMs: 5000, downMs: 1000 });
		expect((await c.network.status()).flapping).toBe(true);
		await c.network.reset();
	});
});

describe("device.location", () => {
	test("set, route, scenario and clear", async () => {
		const { c, driver } = setup();
		await c.location.set({ lat: -36.8, lon: 174.7 });
		await c.location.route(
			[
				{ lat: 1, lon: 2 },
				{ lat: 3, lon: 4 },
			],
			{ speedMps: 5, loop: true }
		);
		await c.location.route({ gpx: "run.gpx" }, { speedMps: 3 });
		await c.location.scenario("city-run");
		await c.location.clear();
		expect(driver.callsOf("location").map((call) => call.op)).toEqual([
			{ kind: "point", lat: -36.8, lon: 174.7 },
			{
				kind: "route",
				points: [
					{ lat: 1, lon: 2 },
					{ lat: 3, lon: 4 },
				],
				speedMps: 5,
				loop: true,
			},
			{ kind: "gpx", path: `${process.cwd()}/run.gpx`, speedMps: 3 },
			{ kind: "scenario", name: "city-run" },
			{ kind: "clear" },
		]);
	});

	test("bad input is INVALID_ARGUMENT", async () => {
		const { c, driver } = setup();
		await expect(c.location.set({ lat: 100, lon: 0 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		await expect(c.location.route([])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		await expect(c.location.scenario("moon" as "freeway")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		expect(driver.callsOf("location")).toEqual([]);
	});

	test("every change emits a condition event", async () => {
		const { c, events } = setup();
		await c.location.set({ lat: 1, lon: 2 });
		expect(events).toMatchObject([{ area: "location", value: { kind: "point", lat: 1, lon: 2 } }]);
	});
});

describe("device.clock", () => {
	test("set takes an ISO string, a Date or epoch ms; frozen on request", async () => {
		const { c, ops } = setup();
		await c.clock.set("2026-03-01T00:00:00Z");
		await c.clock.set(new Date("2026-03-02T00:00:00Z"), { frozen: true });
		await c.clock.set(Date.parse("2026-03-03T00:00:00Z"));
		expect(ops).toEqual([
			{ kind: "fixed", at: "2026-03-01T00:00:00.000Z" },
			{ kind: "frozen", at: "2026-03-02T00:00:00.000Z" },
			{ kind: "fixed", at: "2026-03-03T00:00:00.000Z" },
		]);
	});

	test("advance from the real clock is an offset; from a set time it moves the time on", async () => {
		const { c, ops, clock } = setup();
		await c.clock.advance("2d");
		await c.clock.reset();
		await c.clock.set("2026-03-01T00:00:00Z");
		clock.time += 60_000;
		await c.clock.advance("1h");
		expect(ops).toEqual([
			{ kind: "offset", ms: 172_800_000 },
			{ kind: "real" },
			{ kind: "fixed", at: "2026-03-01T00:00:00.000Z" },
			{ kind: "fixed", at: "2026-03-01T01:01:00.000Z" },
		]);
	});

	test("advance keeps a frozen clock frozen, and adds to an offset", async () => {
		const { c, ops } = setup();
		await c.clock.set("2026-03-01T00:00:00Z", { frozen: true });
		await c.clock.advance("1d");
		await c.clock.reset();
		await c.clock.advance("1d");
		await c.clock.advance("1d");
		expect(ops.at(1)).toEqual({ kind: "frozen", at: "2026-03-02T00:00:00.000Z" });
		expect(ops.at(-1)).toEqual({ kind: "offset", ms: 172_800_000 });
	});

	test("during restores the previous clock, even when fn throws", async () => {
		const { c, ops } = setup();
		await expect(
			c.clock.during("2030-01-01T00:00:00Z", async () => {
				throw new Error("boom");
			})
		).rejects.toThrow("boom");
		expect(ops).toEqual([{ kind: "fixed", at: "2030-01-01T00:00:00.000Z" }, { kind: "real" }]);
	});

	test("a bad time or duration is INVALID_ARGUMENT", async () => {
		const { c, ops } = setup();
		await expect(c.clock.set("yesterday-ish")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		await expect(c.clock.advance("a while")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		expect(ops).toEqual([]);
	});

	test("a driver without a clock op answers E_UNSUPPORTED", async () => {
		const { c } = setup({ clockOp: false });
		const error = await c.clock.set("2026-03-01T00:00:00Z").catch((e: E2eError) => e);
		expect(error).toMatchObject({ code: "ACTION_FAILED" });
		expect((error as E2eError).message).toContain("E_UNSUPPORTED");
	});

	test("every change emits a condition event", async () => {
		const { c, events } = setup();
		await c.clock.set("2026-03-01T00:00:00Z");
		expect(events).toMatchObject([{ area: "clock", value: { kind: "fixed", at: "2026-03-01T00:00:00.000Z" } }]);
	});
});

describe("device.timeline", () => {
	test("runs the steps at their times and stops at teardown", async () => {
		const { c, driver } = setup();
		const run = await c.timeline([{ at: 0, network: "offline", location: { lat: 1, lon: 2 } }]);
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
		expect(networkOps(driver.calls)).toEqual([{ kind: "offline" }]);
		expect(driver.callsOf("location")[0]?.op).toEqual({ kind: "point", lat: 1, lon: 2 });
		await c.internals.teardown();
		expect(["finished", "stopped"]).toContain(run.status().state);
	});

	test("bad steps are INVALID_ARGUMENT", async () => {
		const { c } = setup();
		await expect(c.timeline([{ at: "later", network: "offline" }])).rejects.toMatchObject({
			code: "INVALID_ARGUMENT",
		});
		await expect(c.timeline([{ at: 0, network: { kind: "flap", upMs: 1, downMs: 1 } }])).rejects.toMatchObject({
			code: "INVALID_ARGUMENT",
		});
	});
});

describe("suite baseline", () => {
	test("applyBaseline puts the declared network, location and clock in place", async () => {
		const { c, driver, ops } = setup({
			conditions: { network: "3g", location: { lat: 1, lon: 2 }, clock: "2026-03-01T00:00:00Z" },
		});
		await c.internals.applyBaseline();
		expect(networkOps(driver.calls)).toEqual([{ kind: "preset", preset: "3g" }]);
		expect(driver.callsOf("location")[0]?.op).toEqual({ kind: "point", lat: 1, lon: 2 });
		expect(ops).toEqual([{ kind: "fixed", at: "2026-03-01T00:00:00.000Z" }]);
	});

	test("nothing declared touches nothing", async () => {
		const { c, driver } = setup({ conditions: { network: "offline" } });
		await c.internals.applyBaseline();
		const quiet = setup();
		await quiet.c.internals.applyBaseline();
		expect(driver.callsOf("network")).toHaveLength(1);
		expect(quiet.driver.calls.filter((call) => call.method === "network" || call.method === "location")).toEqual([]);
	});

	test("teardown puts changed areas back to the baseline, leaving untouched ones alone", async () => {
		const { c, driver, ops } = setup({ conditions: { network: "3g" } });
		await c.internals.applyBaseline();
		await c.network.set("offline");
		await c.location.set({ lat: 1, lon: 2 });
		await c.clock.advance("1d");
		await c.internals.teardown();
		expect(networkOps(driver.calls).at(-1)).toEqual({ kind: "preset", preset: "3g" });
		expect(driver.callsOf("location").at(-1)?.op).toEqual({ kind: "clear" });
		expect(ops.at(-1)).toEqual({ kind: "real" });
	});

	test("teardown with nothing changed makes no driver call", async () => {
		const { c, driver, ops } = setup({ conditions: { network: "3g" } });
		await c.internals.applyBaseline();
		const before = driver.calls.length;
		await c.internals.teardown();
		expect(driver.calls.length).toBe(before);
		expect(ops).toEqual([]);
	});

	test("teardown stops a running flap and restores the baseline network", async () => {
		const { c, driver } = setup({ conditions: { network: "3g" } });
		await c.internals.applyBaseline();
		const run = await c.network.flap({ up: "10s", down: "2s", base: "3g" });
		await c.internals.teardown();
		expect(run.status().state).toBe("stopped");
		expect(networkOps(driver.calls).at(-1)).toEqual({ kind: "preset", preset: "3g" });
	});

	test("teardown restores even when the area was changed and the change failed", async () => {
		const { c, driver } = setup();
		await c.network.set("offline");
		await c.internals.teardown();
		expect(networkOps(driver.calls).at(-1)).toEqual({ kind: "online" });
	});

	test("permissions, locale and a11y in a suite config are applied, not warned about", async () => {
		const log: string[] = [];
		const conditions = { network: "wifi", locale: "fr", a11y: { boldText: true } } as const;
		const first = setup({ conditions, log });
		await first.c.internals.applyBaseline();
		expect(log).toEqual([]);
		expect(first.driver.callsOf("locale")[0]).toMatchObject({ tag: "fr" });
		expect(first.driver.callsOf("a11y")[0]).toMatchObject({ op: { boldText: true } });
	});
});

describe("wantsInject", () => {
	test("is on when the suite declares a network or clock condition", () => {
		expect(setup({ conditions: { network: "3g" } }).c.internals.wantsInject()).toBe(true);
		expect(setup({ conditions: { clock: "2026-03-01T00:00:00Z" } }).c.internals.wantsInject()).toBe(true);
		expect(setup({ conditions: { location: { lat: 1, lon: 2 } } }).c.internals.wantsInject()).toBe(false);
		expect(setup().c.internals.wantsInject()).toBe(false);
	});

	test("is on once a network or clock condition is active", async () => {
		const { c } = setup();
		await c.network.set("offline");
		expect(c.internals.wantsInject()).toBe(true);
		await c.network.reset();
		expect(c.internals.wantsInject()).toBe(false);
		await c.clock.advance("1d");
		expect(c.internals.wantsInject()).toBe(true);
	});
});
