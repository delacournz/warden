import { describe, expect, test } from "bun:test";
import type { E2eEnv } from "../env";
import { setDefaultDriverFactory } from "../session";
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

	test("android is a stub until D9", async () => {
		const result = await openDriver(env("android"));
		expect(!result.success && result.error).toMatchObject({
			code: "E_UNSUPPORTED",
			message: "Android driver lands in D9",
		});
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
	const result = await defaultDriverFactory(env("android"));
	expect(!result.success && result.error.code).toBe("E_UNSUPPORTED");
	setDefaultDriverFactory(undefined);
});
