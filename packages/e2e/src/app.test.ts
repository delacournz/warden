import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { fakeDriver, snapshotOf } from "./driver/driver.testing";
import type { E2eEnv } from "./env";
import { E2eError } from "./errors";

const baseEnv: E2eEnv = {
	udid: "UDID",
	platform: "ios",
	bundleId: "com.example.app",
	launchArgs: ["--initialUrl", "http://localhost:8081"],
	out: "/tmp/out",
	timeoutMs: 1000,
	actionTimeoutMs: 1000,
	assertionTimeoutMs: 1000,
	headless: false,
	logTimestamps: false,
};

function setup(env: Partial<E2eEnv> = {}) {
	const driver = fakeDriver({ screens: [snapshotOf([])] });
	const app = createApp({ session: { out: "/tmp/out" }, driver, env: { ...baseEnv, ...env } });
	return { driver, app };
}

describe("app.open", () => {
	test("passes WARDEN_LAUNCH_ARGS then call args and env, relaunching", async () => {
		const { driver, app } = setup();
		await app.open({ args: ["--flag"], env: { A: "1" } });
		expect(driver.callsOf("app.launch")).toEqual([
			{
				method: "app.launch",
				bundleId: "com.example.app",
				opts: { args: ["--initialUrl", "http://localhost:8081", "--flag"], env: { A: "1" }, relaunch: true },
			},
		]);
		expect(driver.callsOf("app.openUrl")).toHaveLength(0);
	});

	test("with no options launches with only the env launch args", async () => {
		const { driver, app } = setup({ launchArgs: [] });
		await app.open();
		expect(driver.callsOf("app.launch")[0]?.opts).toEqual({ args: [], relaunch: true });
	});

	test("url is opened after the launch", async () => {
		const { driver, app } = setup();
		await app.open({ url: "myapp://home" });
		expect(driver.calls.map((c) => c.method)).toEqual(["app.launch", "app.openUrl"]);
		expect(driver.callsOf("app.openUrl")[0]?.url).toBe("myapp://home");
	});
});

describe("app.open on a running app", () => {
	test.each(["ios", "android"] as const)("%s: asks the driver to terminate the running instance", async (platform) => {
		const { driver, app } = setup({ platform, launchArgs: [] });
		await app.open();
		await app.open();
		expect(driver.callsOf("app.launch").map((call) => call.opts?.relaunch)).toEqual([true, true]);
	});
});

describe("app lifecycle", () => {
	test("close terminates", async () => {
		const { driver, app } = setup();
		await app.close();
		expect(driver.callsOf("app.terminate")).toEqual([{ method: "app.terminate", bundleId: "com.example.app" }]);
	});

	test("restart is one relaunch (the launch terminates), not a terminate plus another", async () => {
		const { driver, app } = setup();
		await app.restart();
		expect(driver.calls.map((c) => c.method)).toEqual(["app.launch"]);
		expect(driver.callsOf("app.launch")[0]?.opts).toEqual({
			args: ["--initialUrl", "http://localhost:8081"],
			relaunch: true,
		});
	});

	test("isRunning reflects the driver", async () => {
		const { app } = setup();
		expect(await app.isRunning()).toBe(false);
		await app.open();
		expect(await app.isRunning()).toBe(true);
	});

	test("clearData asks the driver to wipe app data and the keychain", async () => {
		const { driver, app } = setup();
		await app.clearData();
		expect(driver.callsOf("app.clearData")).toEqual([
			{ method: "app.clearData", bundleId: "com.example.app", opts: { keychain: true } },
		]);
	});
});

describe("app.reinstall", () => {
	test("errors INVALID_ARGUMENT without WARDEN_APP_PATH, touching nothing", async () => {
		const { driver, app } = setup();
		const error = await app.reinstall().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(E2eError);
		expect((error as E2eError).code).toBe("INVALID_ARGUMENT");
		expect((error as E2eError).message).toContain("WARDEN_APP_PATH");
		expect(driver.calls).toHaveLength(0);
	});

	test("uninstalls an installed app then installs from the app path", async () => {
		const { driver, app } = setup({ appPath: "/builds/app.app" });
		await app.open();
		driver.calls.length = 0;
		await app.reinstall();
		expect(driver.calls.map((c) => c.method)).toEqual(["app.isInstalled", "app.uninstall", "app.install"]);
		expect(driver.callsOf("app.install")[0]?.path).toBe("/builds/app.app");
	});

	test("skips the uninstall when the app is not installed", async () => {
		const { driver, app } = setup({ appPath: "/builds/app.app" });
		await app.reinstall();
		expect(driver.callsOf("app.uninstall")).toHaveLength(0);
		expect(driver.callsOf("app.install")).toHaveLength(1);
	});
});

describe("signal", () => {
	test("an aborted session signal fails calls with TIMEOUT before touching the driver", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([])] });
		const controller = new AbortController();
		controller.abort();
		const app = createApp({ session: { out: "/tmp/out", signal: controller.signal }, driver, env: baseEnv });
		const error = await app.open().catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("TIMEOUT");
		expect(driver.calls).toHaveLength(0);
	});
});
