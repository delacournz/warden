import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { devtoolsErr } from "./devtools/devtools.types";
import { type ElementSpec, el, type FakeDriver, failWith, fakeDriver, snapshotOf } from "./driver/driver.testing";
import type { Platform, Snapshot } from "./driver/driver.types";
import { cacheObservations } from "./driver/observation-cache";
import type { E2eEnv } from "./env";
import { E2eError } from "./errors";
import { createScreen } from "./screen/screen";
import { testHost } from "./screen/screen.testing";

const baseEnv: E2eEnv = {
	udid: "UDID",
	platform: "ios",
	bundleId: "com.example.app",
	launchArgs: ["--initialUrl", "http://localhost:8081"],
	out: "/tmp/out",
	timeoutMs: 1000,
	actionTimeoutMs: 1000,
	assertionTimeoutMs: 1000,
	logTimestamps: false,
};

/** a first screen: one control, so `wait: "quiet"` sees content on its first look */
const CONTENT = snapshotOf([el("button", { label: "Next" })]);

function setup(env: Partial<E2eEnv> = {}) {
	const driver = fakeDriver({ screens: [CONTENT] });
	const app = createApp({ session: { out: "/tmp/out" }, driver, env: { ...baseEnv, ...env } });
	return { driver, app };
}

function fakeClock() {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
	};
}

/** A driver that shows `launch` until `contentAt` ms on `clock`, then `content`. */
function launchingDriver(
	clock: { now: () => number },
	options: { contentAt: number; launch?: ElementSpec[]; content?: ElementSpec[]; platform?: Platform }
): FakeDriver {
	const platform = options.platform ?? "ios";
	const launch: Snapshot = snapshotOf(options.launch ?? [el("image")], { platform });
	const content: Snapshot = snapshotOf(options.content ?? [el("text", { id: "welcome.screen", label: "Welcome" })], {
		platform,
	});
	return fakeDriver({ platform, screens: () => (clock.now() >= options.contentAt ? content : launch) });
}

describe("app.open", () => {
	test("with Metro, attaches devtools after the launch so LogBox is turned off", async () => {
		const driver = fakeDriver({ screens: [CONTENT] });
		let attaches = 0;
		const session = {
			out: "/tmp/out",
			devtools: () => {
				attaches++;
				expect(driver.callsOf("app.launch")).toHaveLength(1);
				return Promise.resolve(devtoolsErr("devtools_unavailable", "not under test"));
			},
		};
		const app = createApp({ session, driver, env: { ...baseEnv, metroUrl: "http://localhost:8081" } });
		await app.open();
		expect(attaches).toBe(1);
	});

	test("without Metro (a release build) devtools are not attached", async () => {
		const driver = fakeDriver({ screens: [CONTENT] });
		let attaches = 0;
		const session = {
			out: "/tmp/out",
			devtools: () => {
				attaches++;
				return Promise.resolve(devtoolsErr("devtools_unavailable", "not under test"));
			},
		};
		await createApp({ session, driver, env: baseEnv }).open();
		expect(attaches).toBe(0);
	});

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

describe("app.open wait", () => {
	test("by default it returns when the launch does: no settle", async () => {
		const { driver, app } = setup();
		await app.open();
		expect(driver.calls.map((c) => c.method)).toEqual(["app.launch"]);
	});

	test('wait: "none" is the default spelled out', async () => {
		const { driver, app } = setup();
		await app.open({ wait: "none" });
		expect(driver.calls.map((c) => c.method)).toEqual(["app.launch"]);
	});

	test('wait: "quiet" looks at the screen once it has content, then settles', async () => {
		const { driver, app } = setup();
		await app.open({ wait: "quiet" });
		expect(driver.calls.map((c) => c.method)).toEqual(["app.launch", "snapshot", "settle"]);
		expect(driver.callsOf("settle")[0]?.opts).toEqual({ quietMs: 250, timeoutMs: 3000 });
	});

	test('wait: "quiet" with a url settles after the link is opened', async () => {
		const { driver, app } = setup();
		await app.open({ url: "myapp://home", wait: "quiet" });
		expect(driver.calls.map((c) => c.method)).toEqual(["app.launch", "app.openUrl", "snapshot", "settle"]);
	});

	test("an app that is not quiet in time is not an error: the next assertion says what is missing", async () => {
		const driver = fakeDriver({
			screens: [CONTENT],
			onCall: (call) => (call.method === "settle" ? { data: { quiet: false, waitedMs: 3000 } } : undefined),
		});
		const app = createApp({ session: { out: "/tmp/out" }, driver, env: baseEnv });
		await app.open({ wait: "quiet" });
		expect(driver.callsOf("settle")).toHaveLength(1);
	});

	test("a driver that cannot settle is not an error either", async () => {
		const driver = fakeDriver({
			screens: [CONTENT],
			onCall: (call) => (call.method === "settle" ? failWith("E_UNSUPPORTED") : undefined),
		});
		const app = createApp({ session: { out: "/tmp/out" }, driver, env: baseEnv });
		await app.open({ wait: "quiet" });
	});

	test("a failing settle is", async () => {
		const driver = fakeDriver({
			screens: [CONTENT],
			onCall: (call) => (call.method === "settle" ? failWith("E_HELPER_CRASHED") : undefined),
		});
		const app = createApp({ session: { out: "/tmp/out" }, driver, env: baseEnv });
		const error = await app.open({ wait: "quiet" }).catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("DRIVER");
	});

	test("anything but quiet, none or { until: locator } is refused before the app is launched", async () => {
		const { driver, app } = setup();
		for (const wait of [{}, { until: "welcome" }, { until: () => true }, null]) {
			const error = await app.open({ wait: wait as never }).catch((e: unknown) => e);
			expect((error as E2eError).code).toBe("INVALID_ARGUMENT");
		}
		expect(driver.calls).toHaveLength(0);
	});

	test("anything but quiet or none is refused before the app is launched", async () => {
		const { driver, app } = setup();
		const error = await app.open({ wait: "idle" as never }).catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("INVALID_ARGUMENT");
		expect(driver.calls).toHaveLength(0);
	});

	test("restart does not wait", async () => {
		const { driver, app } = setup();
		await app.restart();
		expect(driver.callsOf("settle")).toHaveLength(0);
	});
});

describe('app.open wait: "quiet" waits for the first screen, not the launch screen', () => {
	test("returns only once the screen has content (a control or a testID), then settles", async () => {
		const clock = fakeClock();
		const driver = launchingDriver(clock, { contentAt: 1000 });
		const app = createApp({ session: { out: "/tmp/out" }, driver, env: baseEnv, clock });
		await app.open({ wait: "quiet" });
		// looks at 0, 100, 300, 700 and 1100 ms (the back-off below)
		expect(clock.now()).toBe(1100);
		const methods = driver.calls.map((c) => c.method);
		expect(methods[0]).toBe("app.launch");
		expect(methods.at(-1)).toBe("settle");
		expect(methods.filter((m) => m === "snapshot")).toHaveLength(5);
	});

	test("backs off 100, 200, then 400 ms between looks, so full dumps do not compete with the cold start", async () => {
		const clock = fakeClock();
		const driver = launchingDriver(clock, { contentAt: Number.POSITIVE_INFINITY });
		const looks: number[] = [];
		const watched = {
			...driver,
			snapshot: (...args: Parameters<FakeDriver["snapshot"]>) => {
				looks.push(clock.now());
				return driver.snapshot(...args);
			},
		};
		const app = createApp({ session: { out: "/tmp/out" }, driver: watched, env: baseEnv, clock });
		await app.open({ wait: "quiet" });
		// the last gap is cut to the 3 s deadline
		expect(looks).toEqual([0, 100, 300, 700, 1100, 1500, 1900, 2300, 2700, 3000]);
	});

	test("polls through the observation cache without reusing a kept snapshot", async () => {
		const clock = fakeClock();
		const inner = launchingDriver(clock, { contentAt: 300 });
		const driver = cacheObservations(inner, { now: clock.now });
		await driver.snapshot();
		const app = createApp({ session: { out: "/tmp/out" }, driver, env: baseEnv, clock });
		await app.open({ wait: "quiet" });
		expect(inner.callsOf("snapshot")).toHaveLength(1 + 3);
		expect(clock.now()).toBe(300);
	});

	test("a launch screen that never gives way is waited out to the 3 s cap, then settled as before", async () => {
		const clock = fakeClock();
		const driver = launchingDriver(clock, { contentAt: Number.POSITIVE_INFINITY });
		const app = createApp({ session: { out: "/tmp/out" }, driver, env: baseEnv, clock });
		await app.open({ wait: "quiet" });
		expect(clock.now()).toBe(3000);
		expect(driver.callsOf("settle")).toHaveLength(1);
	});

	test("hidden elements and Android's window decor ids are not content", async () => {
		const clock = fakeClock();
		const driver = launchingDriver(clock, {
			platform: "android",
			contentAt: 500,
			launch: [
				el("other", { id: "action_bar_root", children: [el("other", { id: "content", children: [el("image")] })] }),
				el("button", { label: "Next", hidden: true }),
			],
			content: [el("other", { id: "action_bar_root", children: [el("other", { id: "content" }), el("button")] })],
		});
		const app = createApp({
			session: { out: "/tmp/out" },
			driver,
			env: { ...baseEnv, platform: "android", launchArgs: [] },
			clock,
		});
		await app.open({ wait: "quiet" });
		expect(clock.now()).toBe(700);
	});

	test("the Android 12+ splash screen's view ids are not content", async () => {
		const clock = fakeClock();
		const driver = launchingDriver(clock, {
			platform: "android",
			contentAt: 500,
			launch: [
				el("other", {
					id: "splashscreen_view",
					children: [el("image", { id: "splashscreen_icon_view" }), el("image", { id: "splashscreen_branding_view" })],
				}),
			],
		});
		const app = createApp({
			session: { out: "/tmp/out" },
			driver,
			env: { ...baseEnv, platform: "android", launchArgs: [] },
			clock,
		});
		await app.open({ wait: "quiet" });
		expect(clock.now()).toBe(700);
	});

	test("a snapshot that fails while the app starts is a look with no content, not an error", async () => {
		const clock = fakeClock();
		let failures = 2;
		const driver = fakeDriver({
			screens: [CONTENT],
			onCall: (call) => (call.method === "snapshot" && failures-- > 0 ? failWith("E_AX_UNAVAILABLE") : undefined),
		});
		const app = createApp({ session: { out: "/tmp/out" }, driver, env: baseEnv, clock });
		await app.open({ wait: "quiet" });
		expect(driver.callsOf("snapshot")).toHaveLength(3);
		expect(clock.now()).toBe(300);
	});
});

describe("app.open wait: { until }", () => {
	test("waits for the locator to show through the screen poll, then settles once", async () => {
		const time = { now: () => 0 };
		const driver = launchingDriver({ now: () => time.now() }, { contentAt: 800 });
		const host = testHost(driver, { cache: true });
		time.now = host.clock.now;
		const screen = createScreen(host);
		const app = createApp({ session: { out: "/tmp/out" }, driver, env: baseEnv, clock: host.clock });
		await app.open({ wait: { until: screen.getByTestId("welcome.screen") } });
		expect(host.clock.now()).toBeGreaterThanOrEqual(800);
		const methods = driver.calls.map((c) => c.method);
		expect(methods[0]).toBe("app.launch");
		expect(methods.at(-1)).toBe("settle");
		expect(methods.filter((m) => m === "settle")).toHaveLength(1);
		expect(driver.callsOf("settle")[0]?.opts).toEqual({ quietMs: 250, timeoutMs: 3000 });
	});

	test("a locator that never shows is a TIMEOUT after `timeout`, with no settle", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([el("image")])] });
		const host = testHost(driver);
		const screen = createScreen(host);
		const app = createApp({ session: { out: "/tmp/out" }, driver, env: baseEnv });
		const error = await app
			.open({ wait: { until: screen.getByTestId("welcome.screen"), timeout: 2000 } })
			.catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("TIMEOUT");
		expect(host.clock.now()).toBeGreaterThanOrEqual(2000);
		expect(driver.callsOf("settle")).toHaveLength(0);
	});

	test("with a url it waits after the link is opened", async () => {
		const driver = fakeDriver({ screens: [CONTENT] });
		const screen = createScreen(testHost(driver));
		const app = createApp({ session: { out: "/tmp/out" }, driver, env: baseEnv });
		await app.open({ url: "myapp://home", wait: { until: screen.getByRole("button", { name: "Next" }) } });
		expect(driver.calls.map((c) => c.method)).toEqual(["app.launch", "app.openUrl", "snapshot", "settle"]);
	});
});

describe("app.open on Android", () => {
	const androidEnv: Partial<E2eEnv> = { platform: "android", launchArgs: ["--initialUrl", "x"] };
	/** the Android driver refuses any launch args or env, as `android-app.ts` does */
	const androidDriver = () =>
		fakeDriver({
			platform: "android",
			screens: [snapshotOf([])],
			onCall: (call) =>
				call.method === "app.launch" && (call.opts?.args?.length ?? 0) > 0 ? failWith("E_UNSUPPORTED") : undefined,
		});

	test("drops WARDEN_LAUNCH_ARGS (Metro's --initialUrl) and launches with no args, logging it once", async () => {
		const driver = androidDriver();
		const lines: string[] = [];
		const app = createApp({
			session: { out: "/tmp/out" },
			driver,
			env: { ...baseEnv, ...androidEnv },
			log: (line) => lines.push(line),
		});
		await app.open();
		await app.restart();
		expect(driver.callsOf("app.launch").map((call) => call.opts)).toEqual([
			{ args: [], relaunch: true },
			{ args: [], relaunch: true },
		]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("--initialUrl");
	});

	test("explicit args still fail loudly", async () => {
		const driver = androidDriver();
		const app = createApp({
			session: { out: "/tmp/out" },
			driver,
			env: { ...baseEnv, ...androidEnv },
			log: () => {},
		});
		const error = await app.open({ args: ["--flag"] }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(E2eError);
		expect(driver.callsOf("app.launch")[0]?.opts?.args).toEqual(["--flag"]);
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
