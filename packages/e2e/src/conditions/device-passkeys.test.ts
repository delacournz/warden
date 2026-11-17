import { describe, expect, test } from "bun:test";
import type { ConditionArea, ConditionValues } from "@delacour/warden-core/conditions/conditions.types";
import { failWith, fakeDriver, snapshotOf } from "../driver/driver.testing";
import type { E2eEnv } from "../env";
import { E2eError } from "../errors";
import type { ConditionEvent } from "./condition-events";
import { createDeviceConditions } from "./device-conditions";
import type { ConditionRecorder } from "./lease-recorder";
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

const clock: TickerClock = { now: () => 1000, sleep: async () => undefined };

type Recorded = { kind: "record" | "settle"; area: ConditionArea; value: unknown };

function setup(extra: Partial<E2eEnv> = {}, onCall?: Parameters<typeof fakeDriver>[0]["onCall"]) {
	const driver = fakeDriver({ screens: [snapshotOf([])], ...(onCall ? { onCall } : {}) });
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
		env: { ...env, ...extra },
		signal: () => undefined,
		sink: (e) => void events.push(e),
		tickerClock: clock,
		recorder,
		log: () => undefined,
	});
	return { c, driver, events, recorded };
}

const PROVIDER = { service: "gms/Svc", primary: "gms/Svc" };

describe("device.passkeys.set", () => {
	test("turns the authenticator on (auto / match by default), records the lease and emits", async () => {
		const { c, driver, events, recorded } = setup();
		const state = await c.passkeys.set();
		expect(driver.callsOf("passkeys")[0]?.op).toEqual({ kind: "set" });
		expect(state).toMatchObject({ enabled: true, mode: "auto", uv: "match" });
		expect(recorded).toEqual([{ kind: "record", area: "passkeys", value: { mode: "auto", uv: "match" } }]);
		expect(events).toEqual([
			{ type: "condition", area: "passkeys", value: { enabled: true, mode: "auto", uv: "match" }, at: 1000 },
		]);
		expect(c.internals.wantsInject()).toBe(true);
		expect(c.internals.dirty()).toBe(true);
	});

	test("passes mode and uv through", async () => {
		const { c, driver } = setup();
		await c.passkeys.set({ mode: "cancel", uv: "skip" });
		expect(driver.callsOf("passkeys")[0]?.op).toEqual({ kind: "set", mode: "cancel", uv: "skip" });
	});

	test("refuses an unknown mode or uv before reaching the driver", async () => {
		const { c, driver } = setup();
		const bad = { mode: "maybe" } as unknown as Parameters<typeof c.passkeys.set>[0];
		await expect(c.passkeys.set(bad)).rejects.toBeInstanceOf(E2eError);
		const badUv = { uv: "sometimes" } as unknown as Parameters<typeof c.passkeys.set>[0];
		await expect(c.passkeys.set(badUv)).rejects.toBeInstanceOf(E2eError);
		expect(driver.callsOf("passkeys")).toEqual([]);
	});

	test("keeps the provider settings the first enable reported on every later record (Android)", async () => {
		let first = true;
		const { c, recorded } = setup({ platform: "android" }, (call) => {
			if (call.method !== "passkeys" || !first) return undefined;
			first = false;
			return { data: { enabled: true, mode: "auto", uv: "match", credentials: [], previousProvider: PROVIDER } };
		});
		await c.passkeys.set();
		await c.passkeys.set({ mode: "cancel" });
		await c.passkeys.off();
		expect(recorded.map((r) => r.value)).toEqual([
			{ mode: "auto", uv: "match", previousProvider: PROVIDER },
			{ mode: "cancel", uv: "match", previousProvider: PROVIDER },
			{ mode: "cancel", uv: "match", previousProvider: PROVIDER },
		]);
		expect(recorded.every((r) => r.kind === "record")).toBe(true);
	});

	test("a driver error surfaces with its code", async () => {
		const { c } = setup({ platform: "android" }, (call) =>
			call.method === "passkeys" ? failWith("E_PASSKEY_API", "needs API 34") : undefined
		);
		const error = await c.passkeys.set().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(E2eError);
		expect(String((error as E2eError).message)).toContain("E_PASSKEY_API");
	});
});

describe("device.passkeys credentials", () => {
	test("add creates a P-256 credential host-side and hands it to the driver, returning it with its key", async () => {
		const { c, driver } = setup();
		const made = await c.passkeys.add({ rpId: "warden.co.nz", userName: "demo@warden.co.nz", credentialId: "AAEC" });
		const op = driver.callsOf("passkeys")[0]?.op;
		expect(op?.kind).toBe("add");
		expect(made).toMatchObject({ credentialId: "AAEC", rpId: "warden.co.nz", signCount: 0 });
		expect(made.privateKey.length).toBeGreaterThan(40);
		expect((await c.passkeys.list()).map((v) => v.credentialId)).toEqual(["AAEC"]);
	});

	test("add refuses a bad rp id without calling the driver", async () => {
		const { c, driver } = setup();
		await expect(c.passkeys.add({ rpId: "https://warden.co.nz", userName: "x" })).rejects.toBeInstanceOf(E2eError);
		expect(driver.callsOf("passkeys")).toEqual([]);
	});

	test("list filters by rp, keys only when asked; remove and clear", async () => {
		const { c } = setup();
		await c.passkeys.add({ rpId: "warden.co.nz", userName: "a", credentialId: "AAAA" });
		await c.passkeys.add({ rpId: "other.example", userName: "b", credentialId: "BBBB" });
		const mine = await c.passkeys.list({ rpId: "warden.co.nz" });
		expect(mine.map((v) => v.credentialId)).toEqual(["AAAA"]);
		expect(mine[0]?.privateKey).toBeUndefined();
		expect((await c.passkeys.list({ withKeys: true }))[0]?.privateKey).toBeDefined();
		await c.passkeys.remove("AAAA");
		expect((await c.passkeys.list()).map((v) => v.credentialId)).toEqual(["BBBB"]);
		await c.passkeys.clear();
		expect(await c.passkeys.list()).toEqual([]);
	});

	test("status reads without changing anything", async () => {
		const { c, driver, recorded } = setup();
		expect(await c.passkeys.status()).toMatchObject({ enabled: false });
		expect(driver.callsOf("passkeys")[0]?.op).toEqual({ kind: "status" });
		expect(recorded).toEqual([]);
		expect(c.internals.dirty()).toBe(false);
	});
});

describe("passkeys baseline and teardown", () => {
	test("without a suite key, teardown turns the authenticator off and keeps the credentials", async () => {
		const { c, driver } = setup();
		await c.passkeys.set({ mode: "cancel" });
		await c.passkeys.add({ rpId: "warden.co.nz", userName: "a", credentialId: "AAAA" });
		await c.internals.teardown();
		const ops = driver.callsOf("passkeys").map((call) => call.op.kind);
		expect(ops.at(-1)).toBe("off");
		expect(ops).not.toContain("clear");
		expect(c.internals.dirty()).toBe(false);
	});

	test("the suite's passkeys are applied before launch and teardown puts them back", async () => {
		const conditions: NonNullable<E2eEnv["conditions"]> = {
			passkeys: {
				mode: "auto",
				uv: "skip",
				credentials: [{ rpId: "warden.co.nz", userName: "seed", credentialId: "SEED" }],
			},
		};
		const { c, driver } = setup({ conditions });
		expect(c.internals.declared).toBe(true);
		expect(c.internals.wantsInject()).toBe(true);
		await c.internals.applyBaseline();
		const ops = driver.callsOf("passkeys").map((call) => call.op);
		expect(ops[0]).toEqual({ kind: "set", mode: "auto", uv: "skip" });
		expect(ops.find((op) => op.kind === "add")).toMatchObject({ credential: { credentialId: "SEED" } });
		expect(c.internals.dirty()).toBe(false);
		await c.passkeys.set({ mode: "fail" });
		await c.internals.teardown();
		expect(driver.callsOf("passkeys").at(-1)?.op).toEqual({ kind: "set", mode: "auto", uv: "skip" });
	});

	test("a seeded credential already on the device is not added again", async () => {
		const conditions: NonNullable<E2eEnv["conditions"]> = {
			passkeys: { credentials: [{ rpId: "warden.co.nz", userName: "seed" }] },
		};
		const { c, driver } = setup({ conditions });
		await c.internals.applyBaseline();
		await c.internals.applyBaseline();
		expect(driver.callsOf("passkeys").filter((call) => call.op.kind === "add")).toHaveLength(1);
	});
});
