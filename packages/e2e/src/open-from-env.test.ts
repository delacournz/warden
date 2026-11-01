import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProxy } from "@delacour/warden-driver/testing/network-proxy";
import { FakeAndroidHost } from "@delacour/warden-driver-android/testing/android-host";
import { fakeExec } from "@delacour/warden-driver-ios/testing/exec";
import { fakeSimd } from "@delacour/warden-driver-ios/testing/simd";
import type { E2eEnv } from "./env";
import { defaultDriverFactory, leaseClockRecorderFor, leaseProxyFor, openDriverFromEnv } from "./open-from-env";
import { setDefaultDriverFactory } from "./session";

const env = (platform: "ios" | "android", extra: Partial<E2eEnv> = {}): E2eEnv => ({
	udid: "UDID-1",
	platform,
	bundleId: "nz.co.x",
	launchArgs: [],
	out: "/tmp/out",
	timeoutMs: 1000,
	actionTimeoutMs: 1000,
	assertionTimeoutMs: 1000,
	logTimestamps: false,
	...extra,
});

describe("openDriverFromEnv", () => {
	test("WARDEN_SIMD from the spec env and WARDEN_E2E_DEBUG from processEnv", async () => {
		const helper = fakeSimd.build(() => ({ data: null }));
		const logs: string[] = [];
		const result = await openDriverFromEnv(env("ios", { simd: "/x/warden-simd" }), {
			processEnv: { WARDEN_E2E_DEBUG: "1", WARDEN_HOME: "/nowhere/.warden" },
			log: (line) => logs.push(line),
			host: { exec: fakeExec.build([["xcrun", {}]]) },
			ios: { spawn: helper.spawn, exists: (path) => path === "/x/warden-simd" },
		});
		if (!result.success) throw new Error(result.error.message);
		expect(helper.spawns[0]?.[0]).toBe("/x/warden-simd");
		await result.data.tap({ x: 1, y: 1 });
		await result.data.close();
		expect(logs.some((line) => /^\[ios\] op tap \d+ ms$/.test(line))).toBe(true);
	});

	test("WARDEN_HOME from processEnv is where the Android state goes", async () => {
		const home = mkdtempSync(join(tmpdir(), "wdn-open-env-home-"));
		const host = new FakeAndroidHost({
			shell: [
				{ match: "getprop sys.boot_completed", reply: "1\n34\n" },
				{ match: "wm size", reply: "Physical size: 1080x2400\n" },
				{ match: "wm density", reply: "Physical density: 420\n" },
				{ match: "uiautomator dump /dev/stdout", reply: "UI hierchary dumped to: /dev/stdout\n" },
			],
			host: [
				{
					match: /exec-out uiautomator dump \/dev\/tty$/,
					reply: '<?xml version="1.0"?><hierarchy rotation="0"><node class="x" bounds="[0,0][1,1]" /></hierarchy>',
				},
			],
		});
		const result = await openDriverFromEnv(env("android"), {
			processEnv: { WARDEN_HOME: home },
			host: { exec: host.exec },
			android: { spawn: host.spawn, execBinary: host.execBinary },
		});
		if (!result.success) throw new Error(result.error.message);
		await result.data.snapshot();
		await result.data.close();
		expect(existsSync(join(home, "android", "UDID-1.json"))).toBe(true);
	});
});

test("defaultDriverFactory has the session's DriverFactory shape", async () => {
	setDefaultDriverFactory(defaultDriverFactory);
	const result = await defaultDriverFactory({ ...env("ios"), simd: "/nowhere/warden-simd" });
	expect(!result.success && result.error.code).toBe("E_HELPER_MISSING");
	setDefaultDriverFactory(undefined);
});

describe("a physical iPhone", () => {
	const PHONE = "00008140-000A0B0C0D0E0F10";

	test("connects to env.iosRunnerSocket, not warden-simd", async () => {
		const result = await openDriverFromEnv(env("ios", { udid: PHONE, iosRunnerSocket: "/nonexistent/r.sock" }), {
			host: { exec: fakeExec.build([]) },
			iosDevice: { defaultTimeoutMs: 100 },
		});
		expect(result.success).toBe(false);
		expect(!result.success && result.error.message).not.toContain("WARDEN_IOS_RUNNER_SOCKET is not set");
	});

	test("without a runner socket it says which variable is missing", async () => {
		const result = await openDriverFromEnv(env("ios", { udid: PHONE }), { host: { exec: fakeExec.build([]) } });
		expect(!result.success && result.error.code).toBe("E_HELPER_MISSING");
		expect(!result.success && result.error.message).toContain("WARDEN_IOS_RUNNER_SOCKET");
	});
});

describe("the lease's shaping proxy", () => {
	test("none without WARDEN_LEASE_ID: network stays unsupported, as under a bare bun test", () => {
		expect(leaseProxyFor(env("android"))).toBeUndefined();
	});

	test("built from WARDEN_LEASE_ID without opening the store", () => {
		const opened: string[] = [];
		const openStore = () => {
			opened.push("store");
			return { success: false as const, error: "not here" };
		};
		expect(leaseProxyFor(env("android", { leaseId: "L1" }), { openStore })).toBeDefined();
		expect(opened).toEqual([]);
	});

	test("ios driver opened under a lease gets a proxy; opening it opens no store", async () => {
		const helper = fakeSimd.build(() => ({ data: null }));
		let opened = 0;
		const result = await openDriverFromEnv(env("ios", { simd: "/x/warden-simd", leaseId: "L1" }), {
			host: { exec: fakeExec.build([["xcrun", {}]]) },
			ios: { spawn: helper.spawn, exists: (path) => path === "/x/warden-simd" },
			openStore: () => {
				opened++;
				return { success: false, error: "not here" };
			},
		});
		expect(result.success).toBe(true);
		if (result.success) await result.data.close();
		expect(opened).toBe(0);
	});

	test("a caller's own proxy is kept", async () => {
		const own = new FakeProxy();
		const result = await openDriverFromEnv(env("ios", { simd: "/x/warden-simd", leaseId: "L1" }), {
			networkProxy: own,
			host: { exec: fakeExec.build([["xcrun", {}]]) },
			ios: { spawn: fakeSimd.build(() => ({ data: null })).spawn, exists: () => true },
		});
		expect(result.success).toBe(true);
		if (result.success) await result.data.close();
	});
});

describe("the lease's clock recorder", () => {
	test("none without a lease id; with one it opens no store until a clock is set", () => {
		let opened = 0;
		const openStore = () => {
			opened++;
			return { success: false as const, error: "not here" };
		};
		expect(leaseClockRecorderFor(env("android"), { openStore })).toBeUndefined();
		expect(leaseClockRecorderFor(env("android", { leaseId: "L1" }), { openStore })).toBeDefined();
		expect(opened).toBe(0);
	});
});
