import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverFixtures, FakeDriver } from "@delacour/warden-driver/testing/driver";
import { screenFactory } from "@delacour/warden-screen/screen";
import { FakeClock } from "@delacour/warden-screen/testing/poll";
import { screenTesting } from "@delacour/warden-screen/testing/screen";
import { createApp } from "./app";
import { createDevice } from "./device";

/**
 * The layers below the runner, used the way an SDK host would: no `WARDEN_*` env, no `FixtureSession`, no
 * `bun:test` runner hooks (`test`/`beforeEach` are only this file's own harness), and no `globalThis` session.
 */
describe("driver, screen, device and app without the runner", () => {
	const appId = "com.example.app";

	test("the WARDEN_* environment is not needed", () => {
		const names = Object.keys(process.env).filter((name) => name.startsWith("WARDEN_E2E_") || name === "WARDEN_UDID");
		expect(names).toEqual([]);
	});

	test("screen taps and reads over a bare driver and clock", async () => {
		const driver = new FakeDriver({
			screens: [
				driverFixtures.snapshotOf([
					driverFixtures.el("button", { id: "go", label: "Go" }),
					driverFixtures.el("text", { id: "title", label: "Hello" }),
				]),
			],
		});
		const screen = screenFactory.createScreen({
			driver: async () => driver,
			env: { actionTimeoutMs: 200, assertionTimeoutMs: 200 },
			clock: new FakeClock(),
		});
		await screen.getByTestId("go").tap();
		expect(driver.callsOf("tap")).toHaveLength(1);
		expect(await screen.getByTestId("title").isVisible()).toBe(true);
	});

	test("screen fills a field", async () => {
		const { driver, state } = screenTesting.fieldFixture({ value: "ab", selectAll: true });
		const screen = screenFactory.createScreen({
			driver: async () => driver,
			env: { actionTimeoutMs: 500, assertionTimeoutMs: 500 },
			clock: new FakeClock(),
		});
		await screen.getByTestId("field").fill("grace");
		expect(state.value).toBe("grace");
	});

	test("device snapshot and screenshot with an artifacts dir and no session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "e2e-standalone-"));
		const driver = new FakeDriver({
			screens: [driverFixtures.snapshotOf([driverFixtures.el("button", { id: "go", label: "Go" })])],
		});
		const events: unknown[] = [];
		const device = createDevice({
			driver,
			artifactsDir: dir,
			appId,
			trace: () => ({ write: (event) => events.push(event) }),
			clock: new FakeClock(),
		});
		expect(device.devtools).toBeUndefined();
		expect(await device.snapshot()).toContain("Go");
		const path = await device.screenshot("home");
		expect(path.startsWith(join(dir, "screenshots"))).toBe(true);
		expect(events).toHaveLength(1);
	});

	test("app opens the app by id, with launch args, and waits for content", async () => {
		const driver = new FakeDriver({
			screens: [driverFixtures.snapshotOf([driverFixtures.el("button", { label: "Next" })])],
		});
		const app = createApp({
			driver,
			appId,
			launchArgs: ["--initialUrl", "http://localhost:8081"],
			clock: new FakeClock(),
		});
		await app.open({ args: ["--flag"] });
		expect(driver.callsOf("app.launch")).toEqual([
			{
				method: "app.launch",
				bundleId: appId,
				opts: { args: ["--initialUrl", "http://localhost:8081", "--flag"], relaunch: true },
			},
		]);
		await app.close();
		expect(driver.callsOf("app.terminate")).toHaveLength(1);
	});

	test("app.reinstall without an appPath says what is missing", async () => {
		const driver = new FakeDriver({ screens: [driverFixtures.snapshotOf([])] });
		const app = createApp({ driver, appId });
		await expect(app.reinstall()).rejects.toThrow("WARDEN_APP_PATH");
	});

	test("the driver's deadline is honoured through the signal option", async () => {
		const driver = new FakeDriver({
			screens: [driverFixtures.snapshotOf([driverFixtures.el("button", { label: "Next" })])],
		});
		const controller = new AbortController();
		const app = createApp({ driver, appId, signal: () => controller.signal, clock: new FakeClock() });
		await app.open();
		expect(driver.callsOf("app.launch")).toHaveLength(1);
	});
});
