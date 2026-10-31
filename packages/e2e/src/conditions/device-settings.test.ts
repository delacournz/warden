import { describe, expect, test } from "bun:test";
import type { ConditionArea, ConditionValues } from "@delacour/warden-core/conditions/conditions.types";
import { type DriverCall, fakeDriver, snapshotOf } from "../driver/driver.testing";
import type { Driver } from "../driver/driver.types";
import type { E2eEnv } from "../env";
import type { ConditionEvent } from "./condition-events";
import { createDeviceConditions } from "./device-conditions";
import type { ConditionRecorder } from "./lease-recorder";
import type { TickerClock } from "./route-ticker";

const env: E2eEnv = {
	udid: "UDID",
	platform: "android",
	bundleId: "com.example.app",
	launchArgs: [],
	out: "/tmp/out",
	timeoutMs: 1000,
	actionTimeoutMs: 1000,
	assertionTimeoutMs: 1000,
	logTimestamps: false,
};

const clock: TickerClock = { now: () => 1000, sleep: async () => undefined };

type Recorded = { kind: "record" | "settle"; area: ConditionArea; value: unknown };

function setup(conditions?: E2eEnv["conditions"], onCall?: Parameters<typeof fakeDriver>[0]["onCall"]) {
	const driver = fakeDriver({
		screens: [snapshotOf([], { platform: "android" })],
		platform: "android",
		...(onCall ? { onCall } : {}),
	});
	const events: ConditionEvent[] = [];
	const recorded: Recorded[] = [];
	const recorder: ConditionRecorder = {
		record: <A extends ConditionArea>(area: A, value: ConditionValues[A]) =>
			void recorded.push({ kind: "record", area, value }),
		settle: <A extends ConditionArea>(area: A, value: ConditionValues[A]) =>
			void recorded.push({ kind: "settle", area, value }),
	};
	const c = createDeviceConditions({
		driver,
		env: { ...env, ...(conditions ? { conditions } : {}) },
		signal: () => undefined,
		sink: (e) => void events.push(e),
		tickerClock: clock,
		recorder,
		log: () => undefined,
	});
	return { c, driver, events, recorded };
}

const methods = (calls: readonly DriverCall[]) => calls.map((call) => call.method);

const previousLondon: Parameters<typeof fakeDriver>[0]["onCall"] = (call) =>
	call.method === "timezone"
		? { data: { ...(call.tz ? { timezone: call.tz } : {}), previous: "Europe/London" } }
		: undefined;

describe("device.permissions", () => {
	test("set targets the session's app by default, records the grants and emits an event", async () => {
		const { c, driver, events, recorded } = setup();
		const state = await c.permissions.set({ location: "denied" });
		expect(state.applied).toEqual([{ permission: "location", state: "denied" }]);
		expect(driver.callsOf("permissions")[0]).toMatchObject({
			grants: { location: "denied" },
			opts: { bundleId: "com.example.app" },
		});
		expect(recorded).toEqual([
			{
				kind: "record",
				area: "permission",
				value: { grants: [{ bundleId: "com.example.app", permission: "location", state: "denied" }] },
			},
		]);
		expect(events[0]).toMatchObject({ area: "permission" });
	});

	test("the record keeps every name set so far", async () => {
		const { c, recorded } = setup();
		await c.permissions.set({ location: "denied" });
		await c.permissions.set({ camera: "granted" });
		const last = recorded.at(-1)?.value as { grants: { permission: string }[] };
		expect(last.grants.map((g) => g.permission)).toEqual(["location", "camera"]);
	});

	test("reset (and teardown) puts each name back to the suite's value, else unset", async () => {
		const { c, driver, recorded } = setup({ permissions: { camera: "granted" } });
		await c.internals.applyBaseline();
		await c.permissions.set({ camera: "denied", location: "denied" });
		await c.internals.teardown();
		const calls = driver.callsOf("permissions");
		expect(calls.at(-1)).toMatchObject({ grants: { camera: "granted", location: "unset" } });
		expect(recorded.at(-1)).toMatchObject({ kind: "settle", area: "permission" });
		expect(c.internals.dirty()).toBe(false);
	});
});

describe("baseline", () => {
	test("permissions, timezone, locale and a11y are applied, permissions first, and mark the suite as declaring", async () => {
		const { c, driver } = setup({
			a11y: { textSize: "accessibility-large" },
			locale: "fr-FR",
			timezone: "Asia/Tokyo",
			permissions: { location: "denied" },
			clock: "2026-01-01T00:00:00Z",
		});
		expect(c.internals.declared).toBe(true);
		await c.internals.applyBaseline();
		expect(methods(driver.calls)).toEqual(["permissions", "timezone", "locale", "a11y", "clock"]);
		expect(driver.callsOf("a11y")[0]).toMatchObject({ op: { textSize: "accessibility-large" } });
		expect(c.internals.dirty()).toBe(false);
	});
});

describe("timezone and locale", () => {
	test("record the previous timezone so release can put it back", async () => {
		const { c, recorded } = setup(undefined, previousLondon);
		await c.timezone("Asia/Tokyo");
		await c.locale("fr-FR");
		expect(recorded.at(-1)).toMatchObject({
			area: "locale",
			value: { timezone: "Asia/Tokyo", previousTimezone: "Europe/London", locale: "fr-FR" },
		});
	});

	test("teardown sends null with the previous timezone, and clears the record", async () => {
		const { c, driver, recorded } = setup(undefined, previousLondon);
		await c.timezone("Asia/Tokyo");
		await c.locale("fr-FR");
		await c.internals.teardown();
		expect(driver.callsOf("timezone").at(-1)).toMatchObject({ tz: null, opts: { previous: "Europe/London" } });
		expect(driver.callsOf("locale").at(-1)).toMatchObject({ tag: null });
		expect(recorded.at(-1)).toMatchObject({ kind: "settle", area: "locale" });
	});
});

describe("a11y and battery", () => {
	test("an unknown text size or an empty op is INVALID_ARGUMENT and touches nothing", async () => {
		const { c, driver } = setup();
		await expect(c.a11y({ textSize: "huge" as never })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		await expect(c.a11y({})).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		expect(driver.calls).toEqual([]);
	});

	test("a11y is recorded with the resolved font scale and reset on teardown", async () => {
		const { c, driver, recorded } = setup();
		await c.a11y({ textSize: 1.5, boldText: true });
		expect(recorded.at(-1)).toMatchObject({ area: "a11y", value: { textSize: 1.5, fontScale: 1.5, boldText: true } });
		await c.internals.teardown();
		expect(driver.callsOf("a11y").at(-1)).toMatchObject({ op: null });
	});

	test("battery records the cosmetic flag and resets on teardown", async () => {
		const { c, driver, recorded } = setup(undefined, (call) =>
			call.method === "battery" ? { data: { ...(call.op ?? {}), cosmetic: true } } : undefined
		);
		await c.battery({ level: 10, charging: false });
		expect(recorded.at(-1)).toMatchObject({ area: "battery", value: { level: 10, charging: false, cosmetic: true } });
		await c.internals.teardown();
		expect(driver.callsOf("battery").at(-1)).toMatchObject({ op: null });
	});
});

describe("memory warning and push", () => {
	test("go to the session's app", async () => {
		const { c, driver } = setup();
		await c.memoryWarning();
		await c.push({ aps: { alert: "hi" } });
		expect(driver.callsOf("memoryWarning")[0]).toMatchObject({ opts: { bundleId: "com.example.app" } });
		expect(driver.callsOf("push")[0]).toMatchObject({
			payload: { aps: { alert: "hi" } },
			opts: { bundleId: "com.example.app" },
		});
	});

	test("a driver without the op throws E_UNSUPPORTED", async () => {
		const { c, driver } = setup();
		(driver as { push?: Driver["push"] }).push = undefined;
		await expect(c.push({ aps: {} })).rejects.toMatchObject({ message: expect.stringContaining("no push op") });
	});

	test("a driver failure is thrown as an E2eError", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (call) =>
				call.method === "memoryWarning"
					? { error: { code: "E_UNSUPPORTED", message: "no way", retryable: false } }
					: undefined,
		});
		const c = createDeviceConditions({ driver, env, signal: () => undefined, tickerClock: clock });
		await expect(c.memoryWarning()).rejects.toMatchObject({ message: expect.stringContaining("no way") });
	});
});
