import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPasskeyCredential, readPasskeyStore } from "@delacour/warden-core/conditions/passkey-store";
import type { DriverResult } from "../driver.types";
import { fakeProxy } from "../network-proxy.testing";
import { createInjectChannel, type InjectFs } from "./inject";
import { createIosNetwork, INJECT_ACK_MS } from "./ios-network";

const TMP = mkdtempSync(join(tmpdir(), "warden-ios-network-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let rigs = 0;
const STATE = "/s/state.json";
const ACK = `${STATE}.ack`;
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

/** The iOS side, faked: a state-file directory, an app that acks writes when `app` is set, and the lease proxy. */
function rig(
	init: { proxyLive?: boolean; running?: string; lastBundle?: string; dylib?: boolean; runningFails?: boolean } = {}
) {
	const files = new Map<string, string>();
	const alive = new Set<number>();
	const fs: InjectFs = {
		mkdir: () => undefined,
		writeAtomic: (path, text) => {
			files.set(path, text);
			if (path === STATE && app.injected) {
				const seq = (JSON.parse(text) as { seq: number }).seq;
				if (!app.silent)
					files.set(
						ACK,
						JSON.stringify({ seq, pid: 501, proxy: app.proxy, camera: app.camera, passkeys: app.passkeys })
					);
			}
		},
		read: (path) => files.get(path),
		remove: (path) => void files.delete(path),
		pidAlive: (pid) => alive.has(pid),
	};
	const app = { injected: false, proxy: true, camera: false, passkeys: false, silent: false };
	rigs += 1;
	const passkeyStore = join(TMP, `rig-${rigs}`, "store.json");
	let t = 0;
	const channel = createInjectChannel({
		statePath: STATE,
		fs,
		now: () => (t += 1),
		sleep: async (ms) => {
			t += ms;
		},
	});
	const proxy = fakeProxy(19_090, init.proxyLive);
	const relaunches: string[] = [];
	const make = () =>
		createIosNetwork({
			proxy,
			channel,
			passkeyStore,
			dylib: () =>
				init.dylib === false
					? { success: false, error: { code: "E_HELPER_MISSING", message: "no dylib", retryable: false } }
					: { success: true, data: "/d/libwarden-inject.dylib" },
			isRunning: async (bundle) =>
				init.runningFails
					? { success: false, error: { code: "E_IO", message: "simctl spawn launchctl failed", retryable: true } }
					: { success: true, data: bundle === init.running },
			lastBundle: () => init.lastBundle,
			now: () => NOW,
			relaunch: async (bundle): DriverResult<void> => {
				relaunches.push(bundle);
				app.injected = true;
				alive.add(501);
				return { success: true, data: undefined };
			},
		});
	const net = make();
	return {
		net,
		fresh: make,
		proxy,
		files,
		passkeyStore,
		relaunches,
		app,
		/** the app is running with the dylib loaded */
		attach: (opts: { proxy?: boolean; camera?: boolean; passkeys?: boolean } = {}) => {
			app.injected = true;
			app.proxy = opts.proxy ?? true;
			app.camera = opts.camera ?? false;
			app.passkeys = opts.passkeys ?? false;
			alive.add(501);
			files.set(
				ACK,
				JSON.stringify({ seq: 0, pid: 501, proxy: app.proxy, camera: app.camera, passkeys: app.passkeys })
			);
		},
	};
}

describe("network on an injected app", () => {
	test("a preset configures the proxy, writes the state and waits for the ack", async () => {
		const r = rig();
		r.attach();
		const result = await r.net.network({ kind: "preset", preset: "3g" });
		expect(result).toEqual({
			success: true,
			data: { online: true, condition: { kind: "preset", preset: "3g" }, needsProxy: [] },
		});
		expect(r.proxy.calls[0]).toMatchObject({ op: "ensure", conditions: { params: { latencyMs: 100, downKbps: 780 } } });
		expect(JSON.parse(r.files.get(STATE) ?? "{}")).toMatchObject({ offline: false });
	});

	test("switching presets reconfigures the live proxy without a new one", async () => {
		const r = rig({ proxyLive: true });
		r.attach();
		await r.net.network({ kind: "preset", preset: "edge" });
		await r.net.network({ kind: "preset", preset: "lte" });
		expect(r.proxy.calls.map((c) => c.op)).toEqual(["update", "update"]);
	});

	test("offline refuses at the proxy and tells the app", async () => {
		const r = rig();
		r.attach();
		const result = await r.net.network({ kind: "offline" });
		expect(result.success && result.data.online).toBe(false);
		expect(r.proxy.calls[0]).toMatchObject({ conditions: { params: { offline: "refuse" } } });
		expect(JSON.parse(r.files.get(STATE) ?? "{}").offline).toBe(true);
	});

	test("back online clears both", async () => {
		const r = rig();
		r.attach();
		await r.net.network({ kind: "offline" });
		const result = await r.net.network({ kind: "online" });
		expect(result.success && result.data.online).toBe(true);
		expect(JSON.parse(r.files.get(STATE) ?? "{}").offline).toBe(false);
		expect(r.proxy.calls.at(-1)).toMatchObject({ op: "update", update: { params: {} } });
	});

	test("an app that does not acknowledge is E_TIMEOUT", async () => {
		const r = rig();
		r.attach();
		r.app.silent = true;
		const result = await r.net.network({ kind: "offline" });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.code).toBe("E_TIMEOUT");
			expect(result.error.message).toContain(String(INJECT_ACK_MS));
		}
	});

	test("flap belongs to the scheduler", async () => {
		const r = rig();
		const result = await r.net.network({ kind: "flap", upMs: 1, downMs: 1 });
		expect(result.success).toBe(false);
		expect(r.proxy.calls).toEqual([]);
	});
});

describe("network before the app has the dylib", () => {
	test("nothing running: staged for the next launch", async () => {
		const r = rig();
		const result = await r.net.network({ kind: "preset", preset: "slow" });
		expect(result).toEqual({
			success: true,
			data: { online: true, condition: { kind: "preset", preset: "slow" }, needsProxy: [], appliesOnLaunch: true },
		});
		expect(r.relaunches).toEqual([]);
	});

	test("a running app without the dylib is E_NETWORK_RELAUNCH with the hint", async () => {
		const r = rig({ running: "com.example", lastBundle: "com.example" });
		const result = await r.net.network({ kind: "offline" });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.code).toBe("E_NETWORK_RELAUNCH");
			expect(result.error.message).toContain("relaunch");
			expect(result.error.detail).toEqual({ bundleId: "com.example" });
		}
		expect(r.relaunches).toEqual([]);
	});

	test("relaunch: true relaunches it with the dylib", async () => {
		const r = rig({ running: "com.example" });
		const result = await r.net.network({ kind: "offline" }, { bundleId: "com.example", relaunch: true });
		expect(r.relaunches).toEqual(["com.example"]);
		expect(result.success && result.data.appliesOnLaunch).toBeUndefined();
	});

	test("relaunch: true is honoured for online too, so later presets apply live", async () => {
		const r = rig({ running: "com.example" });
		const result = await r.net.network({ kind: "online" }, { bundleId: "com.example", relaunch: true });
		expect(result.success).toBe(true);
		expect(r.relaunches).toEqual(["com.example"]);
	});

	test("an isRunning that fails is the error, never a silent stage", async () => {
		const r = rig({ lastBundle: "com.example", runningFails: true });
		const result = await r.net.network({ kind: "preset", preset: "3g" });
		expect(!result.success && result.error.code).toBe("E_IO");
		expect(r.relaunches).toEqual([]);
	});

	test("relaunch: true for the clock surfaces a failed isRunning too", async () => {
		const r = rig({ runningFails: true });
		const result = await r.net.clock({ kind: "offset", ms: DAY }, { bundleId: "com.example", relaunch: true });
		expect(!result.success && result.error.code).toBe("E_IO");
	});

	test("an app launched with the dylib but no proxy address needs the relaunch too", async () => {
		const r = rig({ running: "com.example", lastBundle: "com.example" });
		r.attach({ proxy: false });
		const result = await r.net.network({ kind: "preset", preset: "3g" });
		expect(!result.success && result.error.code).toBe("E_NETWORK_RELAUNCH");
	});

	test("going online with no proxy and no app does nothing to the lease", async () => {
		const r = rig();
		const result = await r.net.network({ kind: "online" });
		expect(result.success).toBe(true);
		expect(r.proxy.calls).toEqual([]);
	});
});

describe("networkFaults", () => {
	test("pushes faults to the proxy and returns the https note for status faults", async () => {
		const r = rig({ proxyLive: true });
		r.attach();
		const result = await r.net.networkFaults([{ match: "api.example.com", action: { kind: "status", code: 503 } }]);
		expect(r.proxy.calls[0]).toMatchObject({
			op: "update",
			update: { faults: [{ match: "api.example.com" }] },
		});
		expect(result.success && result.data.notes[0]).toContain("https://");
	});

	test("clearing them keeps the current condition", async () => {
		const r = rig();
		r.attach();
		await r.net.network({ kind: "preset", preset: "4g" });
		await r.net.networkFaults([{ match: "x", action: { kind: "reset" } }]);
		await r.net.networkFaults([]);
		expect(r.proxy.calls.at(-1)).toMatchObject({ update: { params: { latencyMs: 170 }, faults: [] } });
	});

	test("a proxy that cannot start is E_IO and the faults roll back", async () => {
		const r = rig();
		r.proxy.failEnsure = "netproxy: no free port";
		const result = await r.net.networkFaults([{ match: "x", action: { kind: "reset" } }]);
		expect(!result.success && result.error.code).toBe("E_IO");
		const again = await r.net.network({ kind: "online" });
		expect(again.success).toBe(true);
	});
});

describe("launchEnv", () => {
	test("a run with no condition launches plainly: no dylib lookup, no proxy", async () => {
		const r = rig({ dylib: false });
		expect(await r.net.launchEnv({})).toEqual({ success: true, data: undefined });
		expect(r.proxy.calls).toEqual([]);
	});

	test("a plain launch forgets the previous app's ack, so a ghost is never attached", async () => {
		const r = rig();
		r.attach();
		expect(await r.net.launchEnv({})).toEqual({ success: true, data: undefined });
		expect(r.files.has(ACK)).toBe(false);
	});

	test("a live proxy injects with its address and stages the state", async () => {
		const r = rig({ proxyLive: true });
		await r.net.network({ kind: "offline" });
		const env = await r.net.launchEnv({});
		expect(env).toEqual({
			success: true,
			data: {
				DYLD_INSERT_LIBRARIES: "/d/libwarden-inject.dylib",
				WARDEN_INJECT_STATE: STATE,
				WARDEN_NET_PROXY: "127.0.0.1:19090",
			},
		});
		expect(JSON.parse(r.files.get(STATE) ?? "{}").offline).toBe(true);
	});

	test("inject: true starts the proxy so the address is in the env", async () => {
		const r = rig();
		const env = await r.net.launchEnv({ inject: true });
		expect(env.success && env.data?.WARDEN_NET_PROXY).toBe("127.0.0.1:19090");
		expect(r.proxy.calls[0]).toMatchObject({ op: "ensure", condition: { kind: "online" } });
	});

	test("a missing dylib fails the launch with the hint", async () => {
		const r = rig({ proxyLive: true, dylib: false });
		const env = await r.net.launchEnv({});
		expect(!env.success && env.error.code).toBe("E_HELPER_MISSING");
	});

	test("a staged clock offset injects without any network condition", async () => {
		const r = rig();
		await r.net.setClockOffset(86_400_000);
		const env = await r.net.launchEnv({});
		expect(env.success && env.data?.WARDEN_CLOCK_OFFSET_MS).toBe("86400000");
		expect(env.success && env.data?.WARDEN_NET_PROXY).toBeUndefined();
	});
});

describe("confirmLoaded", () => {
	test("passes when the launched app acknowledges its first state", async () => {
		const r = rig({ proxyLive: true });
		await r.net.launchEnv({});
		r.attach();
		const seq = (JSON.parse(r.files.get(STATE) ?? "{}") as { seq: number }).seq;
		r.files.set(ACK, JSON.stringify({ seq, pid: 501, proxy: true }));
		expect((await r.net.confirmLoaded()).success).toBe(true);
	});

	test("fails with E_INTERNAL when the dylib never loaded", async () => {
		const r = rig({ proxyLive: true });
		await r.net.launchEnv({});
		const result = await r.net.confirmLoaded();
		expect(!result.success && result.error.code).toBe("E_INTERNAL");
	});

	test("does nothing after a plain launch", async () => {
		const r = rig();
		await r.net.launchEnv({});
		expect((await r.net.confirmLoaded()).success).toBe(true);
	});
});

describe("setClockOffset (COND-12 hook)", () => {
	test("is live on an injected app and keeps the network state", async () => {
		const r = rig();
		r.attach();
		await r.net.network({ kind: "offline" });
		const result = await r.net.setClockOffset(3_600_000);
		expect(result.success).toBe(true);
		expect(JSON.parse(r.files.get(STATE) ?? "{}")).toMatchObject({ offline: true, clockOffsetMs: 3_600_000 });
	});
});

describe("clock (COND-12)", () => {
	const stateOf = (r: ReturnType<typeof rig>) => JSON.parse(r.files.get(STATE) ?? "{}") as Record<string, unknown>;

	test("offset is live on an injected app and reports what the device reads", async () => {
		const r = rig();
		r.attach();
		const result = await r.net.clock({ kind: "offset", ms: 2 * DAY });
		expect(result).toEqual({
			success: true,
			data: { condition: { kind: "offset", ms: 2 * DAY }, offsetMs: 2 * DAY, frozen: false, nowMs: NOW + 2 * DAY },
		});
		expect(stateOf(r)).toMatchObject({ clockOffsetMs: 2 * DAY });
		expect(stateOf(r).clockFrozenMs).toBeUndefined();
	});

	test("fixed computes the offset from now and lets the clock run", async () => {
		const r = rig();
		r.attach();
		const at = new Date(NOW + 15 * DAY).toISOString();
		const result = await r.net.clock({ kind: "fixed", at });
		expect(result.success && result.data).toMatchObject({ offsetMs: 15 * DAY, frozen: false, nowMs: NOW + 15 * DAY });
		expect(stateOf(r)).toMatchObject({ clockOffsetMs: 15 * DAY });
	});

	test("frozen holds the instant", async () => {
		const r = rig();
		r.attach();
		const at = new Date(NOW - DAY).toISOString();
		const result = await r.net.clock({ kind: "frozen", at });
		expect(result.success && result.data).toMatchObject({ offsetMs: 0, frozen: true, nowMs: NOW - DAY });
		expect(stateOf(r)).toMatchObject({ clockOffsetMs: 0, clockFrozenMs: NOW - DAY });
	});

	test("real puts both back", async () => {
		const r = rig();
		r.attach();
		await r.net.clock({ kind: "frozen", at: new Date(NOW).toISOString() });
		const result = await r.net.clock({ kind: "real" });
		expect(result.success && result.data).toMatchObject({ offsetMs: 0, frozen: false, nowMs: NOW });
		expect(stateOf(r).clockFrozenMs).toBeUndefined();
		expect(stateOf(r).clockOffsetMs).toBe(0);
	});

	test("keeps the network state", async () => {
		const r = rig();
		r.attach();
		await r.net.network({ kind: "offline" });
		await r.net.clock({ kind: "offset", ms: DAY });
		expect(stateOf(r)).toMatchObject({ offline: true, clockOffsetMs: DAY });
	});

	test("an app without the dylib gets it from the next launch", async () => {
		const r = rig();
		const result = await r.net.clock({ kind: "offset", ms: DAY });
		expect(result.success && result.data.appliesOnLaunch).toBe(true);
		const env = await r.net.launchEnv({});
		expect(env.success && env.data?.WARDEN_CLOCK_OFFSET_MS).toBe(String(DAY));
	});

	test("a staged freeze reaches the launch env", async () => {
		const r = rig();
		await r.net.clock({ kind: "frozen", at: new Date(NOW).toISOString() });
		const env = await r.net.launchEnv({});
		expect(env.success && env.data?.WARDEN_CLOCK_FROZEN_MS).toBe(String(NOW));
	});

	test("relaunch: true puts the dylib into a running plain app", async () => {
		const r = rig({ running: "com.app", lastBundle: "com.app" });
		const result = await r.net.clock({ kind: "offset", ms: DAY }, { relaunch: true });
		expect(r.relaunches).toEqual(["com.app"]);
		expect(result.success && result.data.appliesOnLaunch).toBeUndefined();
	});

	test("an unreadable instant is E_BAD_REQUEST and changes nothing", async () => {
		const r = rig();
		r.attach();
		const result = await r.net.clock({ kind: "fixed", at: "not a date" });
		expect(!result.success && result.error.code).toBe("E_BAD_REQUEST");
		expect(r.files.has(STATE)).toBe(false);
	});
});

describe("camera", () => {
	const back = { kind: "image" as const, path: "/w/camera/U1/back-aaa.png" };
	const stateOf = (r: ReturnType<typeof rig>) => JSON.parse(r.files.get(STATE) ?? "{}");

	test("an app launched with the camera gets a new feed live, acked", async () => {
		const r = rig();
		r.attach({ camera: true });
		const done = await r.net.camera({ back });
		expect(done).toEqual({ success: true, data: { feeds: { back } } });
		expect(stateOf(r).camera).toEqual({ back });
	});

	test("nothing running: the feed waits for the next launch, which loads the dylib with the camera on", async () => {
		const r = rig();
		const done = await r.net.camera({ back });
		expect(done).toEqual({ success: true, data: { feeds: { back }, appliesOnLaunch: true } });
		const env = await r.net.launchEnv({});
		expect(env.success && env.data?.WARDEN_CAMERA).toBe("1");
		expect(env.success && env.data?.DYLD_INSERT_LIBRARIES).toBe("/d/libwarden-inject.dylib");
		expect(stateOf(r).camera).toEqual({ back });
		expect(r.proxy.calls.some((c) => c.op === "ensure")).toBe(false);
	});

	test("an injected app launched without the camera cannot get one live", async () => {
		const r = rig();
		r.attach({ camera: false });
		const done = await r.net.camera({ back });
		expect(done.success && done.data.appliesOnLaunch).toBe(true);
	});

	test("taking the feeds off reaches the running app as an empty camera, then launches stay plain", async () => {
		const r = rig();
		r.attach({ camera: true });
		await r.net.camera({ back });
		const off = await r.net.camera(null);
		expect(off).toEqual({ success: true, data: { feeds: {} } });
		expect(stateOf(r).camera).toEqual({});
		const env = await r.net.launchEnv({});
		expect(env).toEqual({ success: true, data: undefined });
	});

	test("the camera survives a network change", async () => {
		const r = rig();
		r.attach({ camera: true });
		await r.net.camera({ back });
		await r.net.network({ kind: "offline" });
		expect(stateOf(r).camera).toEqual({ back });
	});
});

describe("passkeys", () => {
	const stateOf = (r: ReturnType<typeof rig>) => JSON.parse(r.files.get(STATE) ?? "{}");
	const credential = (rpId: string, createdAt: number) => {
		const made = createPasskeyCredential({ rpId, userName: "ada" }, { now: () => createdAt });
		if (!made.success) throw new Error(made.error);
		return made.data;
	};

	test("an app launched with the authenticator gets mode and uv live, acked, with the store path", async () => {
		const r = rig();
		r.attach({ passkeys: true });
		const done = await r.net.passkeys({ kind: "set", mode: "cancel", uv: "skip" });
		expect(done).toEqual({ success: true, data: { enabled: true, mode: "cancel", uv: "skip", credentials: [] } });
		expect(stateOf(r).passkeys).toEqual({ mode: "cancel", uv: "skip", storePath: r.passkeyStore });
	});

	test("a field left out keeps its value; the first set is auto / match", async () => {
		const r = rig();
		r.attach({ passkeys: true });
		const first = await r.net.passkeys({ kind: "set" });
		expect(first.success && [first.data.mode, first.data.uv]).toEqual(["auto", "match"]);
		await r.net.passkeys({ kind: "set", mode: "fail" });
		const second = await r.net.passkeys({ kind: "set", uv: "nomatch" });
		expect(second.success && [second.data.mode, second.data.uv]).toEqual(["fail", "nomatch"]);
	});

	test("nothing running: it waits for the next launch, which loads the dylib with the authenticator on, no proxy", async () => {
		const r = rig();
		const done = await r.net.passkeys({ kind: "set", mode: "auto" });
		expect(done).toEqual({
			success: true,
			data: { enabled: true, mode: "auto", uv: "match", credentials: [], appliesOnLaunch: true },
		});
		const env = await r.net.launchEnv({});
		expect(env.success && env.data?.WARDEN_PASSKEYS).toBe("1");
		expect(env.success && env.data?.DYLD_INSERT_LIBRARIES).toBe("/d/libwarden-inject.dylib");
		expect(env.success && env.data).not.toHaveProperty("WARDEN_NET_PROXY");
		expect(stateOf(r).passkeys).toEqual({ mode: "auto", uv: "match", storePath: r.passkeyStore });
		expect(r.proxy.calls.some((c) => c.op === "ensure")).toBe(false);
	});

	test("an injected app launched without the authenticator cannot get it live", async () => {
		const r = rig();
		r.attach({ passkeys: false });
		const done = await r.net.passkeys({ kind: "set" });
		expect(done.success && done.data.appliesOnLaunch).toBe(true);
	});

	test("an app that never acks is E_TIMEOUT", async () => {
		const r = rig();
		r.attach({ passkeys: true });
		r.app.silent = true;
		const done = await r.net.passkeys({ kind: "set" });
		expect(!done.success && done.error.code).toBe("E_TIMEOUT");
		expect(!done.success && done.error.message).toContain(String(INJECT_ACK_MS));
	});

	test("off removes the state key for the running app, keeps the credentials, and launches stay plain", async () => {
		const r = rig();
		r.attach({ passkeys: true });
		await r.net.passkeys({ kind: "set" });
		await r.net.passkeys({ kind: "add", credential: credential("example.com", 1) });
		const off = await r.net.passkeys({ kind: "off" });
		expect(off.success && [off.data.enabled, off.data.credentials.length]).toEqual([false, 1]);
		expect(stateOf(r)).not.toHaveProperty("passkeys");
		expect(await r.net.launchEnv({})).toEqual({ success: true, data: undefined });
	});

	test("the authenticator survives a network change and a new driver reads it back from the state file", async () => {
		const r = rig();
		r.attach({ passkeys: true });
		await r.net.passkeys({ kind: "set", mode: "fail" });
		await r.net.network({ kind: "offline" });
		expect(stateOf(r).passkeys).toMatchObject({ mode: "fail" });
		const again = await r.fresh().passkeys({ kind: "status" });
		expect(again.success && [again.data.enabled, again.data.mode]).toEqual([true, "fail"]);
	});

	test("add, remove, clear and list work on the store file; list filters by rp, newest first, keys only with withKeys", async () => {
		const r = rig();
		const a = credential("a.example.com", 1);
		const b = credential("a.example.com", 3);
		const c = credential("b.example.com", 2);
		for (const credentialOp of [a, b, c]) await r.net.passkeys({ kind: "add", credential: credentialOp });
		const stored = readPasskeyStore(r.passkeyStore);
		expect(stored.success && stored.data.map((x) => x.credentialId)).toEqual([a, b, c].map((x) => x.credentialId));

		const listed = await r.net.passkeys({ kind: "list", rpId: "a.example.com" });
		expect(listed.success && listed.data.credentials.map((x) => x.credentialId)).toEqual([
			b.credentialId,
			a.credentialId,
		]);
		expect(listed.success && listed.data.credentials[0]).not.toHaveProperty("privateKey");
		const withKeys = await r.net.passkeys({ kind: "list", withKeys: true });
		expect(withKeys.success && withKeys.data.credentials.every((x) => typeof x.privateKey === "string")).toBe(true);

		const removed = await r.net.passkeys({ kind: "remove", credentialId: b.credentialId });
		expect(removed.success && removed.data.credentials.map((x) => x.credentialId)).toEqual([
			c.credentialId,
			a.credentialId,
		]);
		const cleared = await r.net.passkeys({ kind: "clear" });
		expect(cleared.success && cleared.data.credentials).toEqual([]);
		expect(r.files.has(STATE)).toBe(false);
	});

	test("a store that does not parse is E_PASSKEY_STORE", async () => {
		const r = rig();
		r.attach({ passkeys: true });
		await r.net.passkeys({ kind: "set" });
		mkdirSync(dirname(r.passkeyStore), { recursive: true });
		writeFileSync(r.passkeyStore, "{ nope");
		for (const op of [{ kind: "list" }, { kind: "status" }, { kind: "clear" }] as const) {
			const result = await r.net.passkeys(op);
			expect(!result.success && result.error.code).toBe("E_PASSKEY_STORE");
		}
	});
});
