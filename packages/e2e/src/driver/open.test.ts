import { describe, expect, test } from "bun:test";
import type { E2eEnv } from "../env";
import { setDefaultDriverFactory } from "../session";
import { fakeAndroidHost } from "./android/android-host.testing";
import { fakeExec } from "./ios/exec.testing";
import { fakeSimd } from "./ios/simd.testing";
import { defaultDriverFactory, openDriver } from "./open";

const env = (platform: "ios" | "android", extra: Partial<E2eEnv> = {}): E2eEnv => ({
	udid: "UDID-1",
	platform,
	bundleId: "nz.co.x",
	launchArgs: [],
	out: "/tmp/out",
	timeoutMs: 1000,
	actionTimeoutMs: 1000,
	assertionTimeoutMs: 1000,
	headless: false,
	logTimestamps: false,
	...extra,
});

describe("openDriver", () => {
	test("ios opens the iOS driver on the env's udid, using env.simd as the helper", async () => {
		const helper = fakeSimd(() => ({ data: null }));
		const result = await openDriver(env("ios", { simd: "/x/warden-simd" }), {
			exec: fakeExec([["xcrun", {}]]),
			spawn: helper.spawn,
			exists: (path) => path === "/x/warden-simd",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.platform).toBe("ios");
		expect(result.data.id).toBe("UDID-1");
		expect(helper.spawns[0]?.slice(0, 3)).toEqual(["/x/warden-simd", "--udid", "UDID-1"]);
		await result.data.close();
	});

	test("WARDEN_E2E_DEBUG=1 turns the latency log on", async () => {
		const previous = process.env.WARDEN_E2E_DEBUG;
		process.env.WARDEN_E2E_DEBUG = "1";
		try {
			const helper = fakeSimd(() => ({ data: null }));
			const logs: string[] = [];
			const result = await openDriver(env("ios"), {
				exec: fakeExec([["xcrun", {}]]),
				spawn: helper.spawn,
				helperPath: "/x/warden-simd",
				exists: () => false,
				log: (line) => logs.push(line),
			});
			if (!result.success) throw new Error(result.error.message);
			await result.data.tap({ x: 1, y: 1 });
			await result.data.close();
			expect(logs.some((line) => /^\[ios\] op tap \d+ ms$/.test(line))).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.WARDEN_E2E_DEBUG;
			else process.env.WARDEN_E2E_DEBUG = previous;
		}
	});

	test("android opens the adb driver with the env serial and the injected host seams", async () => {
		const host = fakeAndroidHost({
			shell: [
				{ match: "getprop sys.boot_completed", reply: "1\n" },
				{ match: "wm size", reply: "Physical size: 1080x2400\n" },
				{ match: "wm density", reply: "Physical density: 420\n" },
			],
		});
		const result = await openDriver(env("android"), {
			exec: host.exec,
			android: { adb: "/sdk/platform-tools/adb", spawn: host.spawn, execBinary: host.execBinary },
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.platform).toBe("android");
		expect(host.spawns()).toBe(1);
		await result.data.close();
	});

	test("a missing helper is E_HELPER_MISSING", async () => {
		const result = await openDriver(env("ios"), {
			exec: fakeExec([["xcrun", {}]]),
			exists: () => false,
			execPath: "/nowhere/warden",
			importDir: "/nowhere/packages/e2e/src/driver/ios",
			wardenHome: "/nowhere/.warden",
		});
		expect(!result.success && result.error.code).toBe("E_HELPER_MISSING");
	});
});

test("defaultDriverFactory has the session's DriverFactory shape", async () => {
	setDefaultDriverFactory(defaultDriverFactory);
	const result = await defaultDriverFactory({ ...env("ios"), simd: "/nowhere/warden-simd" });
	expect(!result.success && result.error.code).toBe("E_HELPER_MISSING");
	setDefaultDriverFactory(undefined);
});
