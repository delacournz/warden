import { describe, expect, test } from "bun:test";
import type { DriverResult } from "../driver.types";
import { fakeProxy } from "../network-proxy.testing";
import { createInjectChannel, type InjectFs } from "./inject";
import { createIosNetwork, INJECT_ACK_MS } from "./ios-network";

const STATE = "/s/state.json";
const ACK = `${STATE}.ack`;

/** The iOS side, faked: a state-file directory, an app that acks writes when `app` is set, and the lease proxy. */
function rig(init: { proxyLive?: boolean; running?: string; lastBundle?: string; dylib?: boolean } = {}) {
	const files = new Map<string, string>();
	const alive = new Set<number>();
	const fs: InjectFs = {
		mkdir: () => undefined,
		writeAtomic: (path, text) => {
			files.set(path, text);
			if (path === STATE && app.injected) {
				const seq = (JSON.parse(text) as { seq: number }).seq;
				if (!app.silent) files.set(ACK, JSON.stringify({ seq, pid: 501, proxy: app.proxy }));
			}
		},
		read: (path) => files.get(path),
		remove: (path) => void files.delete(path),
		pidAlive: (pid) => alive.has(pid),
	};
	const app = { injected: false, proxy: true, silent: false };
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
	const net = createIosNetwork({
		proxy,
		channel,
		dylib: () =>
			init.dylib === false
				? { success: false, error: { code: "E_HELPER_MISSING", message: "no dylib", retryable: false } }
				: { success: true, data: "/d/libwarden-inject.dylib" },
		isRunning: async (bundle) => ({ success: true, data: bundle === init.running }),
		lastBundle: () => init.lastBundle,
		relaunch: async (bundle): DriverResult<void> => {
			relaunches.push(bundle);
			app.injected = true;
			alive.add(501);
			return { success: true, data: undefined };
		},
	});
	return {
		net,
		proxy,
		files,
		relaunches,
		app,
		/** the app is running with the dylib loaded */
		attach: (opts: { proxy?: boolean } = {}) => {
			app.injected = true;
			app.proxy = opts.proxy ?? true;
			alive.add(501);
			files.set(ACK, JSON.stringify({ seq: 0, pid: 501, proxy: app.proxy }));
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
