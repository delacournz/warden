import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevice } from "./device";
import { type ElementSpec, el, type FakeDriver, failWith, fakeDriver, snapshotOf } from "./driver/driver.testing";
import type { Platform, Snapshot } from "./driver/driver.types";
import type { E2eEnv } from "./env";
import type { E2eError } from "./errors";
import type { Clock, FixtureSession } from "./fixture-session";

const env: E2eEnv = {
	udid: "UDID",
	platform: "ios",
	bundleId: "com.example.app",
	launchArgs: [],
	out: "/tmp/out",
	timeoutMs: 1000,
	actionTimeoutMs: 1000,
	assertionTimeoutMs: 1000,
	headless: false,
	logTimestamps: false,
};

function fakeClock(): Clock & { time: () => number } {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms) => {
			t += ms;
		},
		time: () => t,
	};
}

const button = (label: string): ElementSpec => el("button", { label });
const alertOf = (...labels: string[]): ElementSpec => el("alert", { label: "Title", children: labels.map(button) });

function setup(
	opts: { screens?: Snapshot[] | (() => Snapshot); platform?: Platform; session?: Partial<FixtureSession> } = {}
) {
	const platform = opts.platform ?? "ios";
	const driver = fakeDriver({ screens: opts.screens ?? [snapshotOf([], { platform })], platform });
	const clock = fakeClock();
	const session: FixtureSession = { out: "/tmp/out", ...opts.session };
	const device = createDevice({ session, driver, env: { ...env, platform }, clock });
	return { driver, device, clock };
}

const withAlert = (...labels: string[]): Snapshot => snapshotOf([alertOf(...labels)]);

/** the y of the button's row centre in a snapshot with an alert at row 0 */
const rowCentre = (index: number): { x: number; y: number } => ({ x: 195, y: index * 50 + 22 });

describe("device.alert", () => {
	test("accept presses the first heuristic match by list order", async () => {
		const { device, driver } = setup({ screens: [withAlert("Cancel", "Allow Once", "Allow While Using App")] });
		expect(await device.alert("accept")).toBe(true);
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(3));
	});

	test("accept matches curly apostrophes and case", async () => {
		const { device, driver } = setup({ screens: [withAlert("Don’t Allow", "ok")] });
		await device.alert("accept");
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
	});

	test("accept falls back to the last button", async () => {
		const { device, driver } = setup({ screens: [withAlert("Delete", "Keep")] });
		await device.alert("accept");
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
	});

	test("dismiss presses the first dismiss word", async () => {
		const { device, driver } = setup({ screens: [withAlert("Save Password", "Not Now")] });
		expect(await device.alert("dismiss")).toBe(true);
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
	});

	test("dismiss falls back to the first button", async () => {
		const { device, driver } = setup({ screens: [withAlert("Delete", "Keep")] });
		await device.alert("dismiss");
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(1));
	});

	test("{button} presses that button", async () => {
		const { device, driver } = setup({ screens: [withAlert("One", "Two", "Three")] });
		expect(await device.alert({ button: "two" })).toBe(true);
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
	});

	test("{button} that is absent is ACTION_FAILED listing the buttons", async () => {
		const { device } = setup({ screens: [withAlert("One")] });
		const error = await device.alert({ button: "Nope" }).catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("ACTION_FAILED");
		expect((error as E2eError).message).toContain("One");
	});

	test("no alert returns false without tapping", async () => {
		const { device, driver } = setup();
		expect(await device.alert("accept")).toBe(false);
		expect(driver.callsOf("tap")).toHaveLength(0);
	});

	test("driver failures become E2eError", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (c) => (c.method === "alert" ? failWith("E_HELPER_CRASHED") : undefined),
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env });
		const error = await device.alert("accept").catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("DRIVER");
	});
});

describe("device.openLink", () => {
	/** an "Open in …?" sheet shows once the fake clock passes `showAt` */
	function delayedSheet(showAt: number) {
		const clock = fakeClock();
		const driver = fakeDriver({
			screens: () => (clock.time() >= showAt ? withAlert("Cancel", "Open") : snapshotOf([])),
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock });
		return { driver, device, clock };
	}

	test("opens the url, then accepts Open when the sheet shows within 3 s", async () => {
		const { driver, device } = delayedSheet(1200);
		await device.openLink("myapp://x");
		expect(driver.callsOf("app.openUrl")[0]?.url).toBe("myapp://x");
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
	});

	test("gives up after 3 s without a sheet", async () => {
		const { driver, device, clock } = delayedSheet(10_000);
		await device.openLink("myapp://x");
		expect(driver.callsOf("tap")).toHaveLength(0);
		expect(clock.time()).toBeGreaterThanOrEqual(3000);
		expect(clock.time()).toBeLessThan(3500);
	});

	test("accept:false skips polling", async () => {
		const { driver, device } = delayedSheet(0);
		await device.openLink("myapp://x", { accept: false });
		expect(driver.callsOf("alert")).toHaveLength(0);
		expect(driver.callsOf("tap")).toHaveLength(0);
	});

	test("Android never polls for the sheet", async () => {
		const { driver, device } = setup({ platform: "android", screens: [withAlert("Cancel", "Open")] });
		await device.openLink("myapp://x");
		expect(driver.callsOf("alert")).toHaveLength(0);
	});

	test("leaves an unrelated alert alone", async () => {
		const clock = fakeClock();
		const driver = fakeDriver({ screens: [withAlert("Cancel", "Delete")] });
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock });
		await device.openLink("myapp://x");
		expect(driver.callsOf("tap")).toHaveLength(0);
	});
});

describe("hardware and system", () => {
	test("home presses the home button", async () => {
		const { driver, device } = setup();
		await device.home();
		expect(driver.callsOf("pressButton")[0]?.button).toBe("home");
	});

	test("back is the Android back key", async () => {
		const { driver, device } = setup({ platform: "android" });
		await device.back();
		expect(driver.callsOf("pressButton")[0]?.button).toBe("back");
	});

	test("back on iOS is INVALID_ARGUMENT", async () => {
		const { device } = setup();
		const error = await device.back().catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("INVALID_ARGUMENT");
	});

	test("orientation, appearance and clipboard round-trip", async () => {
		const { device } = setup();
		expect(await device.orientation("landscapeLeft")).toBe("landscapeLeft");
		expect(await device.orientation()).toBe("landscapeLeft");
		expect(await device.appearance("dark")).toBe("dark");
		await device.setClipboard("hello");
		expect(await device.clipboard()).toBe("hello");
	});
});

describe("device.hideKeyboard", () => {
	const withKeyboard = snapshotOf([el("textfield", { id: "email" }), el("keyboard")]);

	test("iOS presses Enter when a keyboard is in the snapshot", async () => {
		const { driver, device } = setup({ screens: [withKeyboard] });
		await device.hideKeyboard();
		expect(driver.callsOf("key")[0]?.key).toBe("Enter");
	});

	test("Android presses back when a keyboard is in the snapshot", async () => {
		const { driver, device } = setup({
			platform: "android",
			screens: [snapshotOf([el("keyboard")], { platform: "android" })],
		});
		await device.hideKeyboard();
		expect(driver.callsOf("pressButton")[0]?.button).toBe("back");
	});

	test("is a no-op without a keyboard", async () => {
		const { driver, device } = setup({ screens: [snapshotOf([el("textfield")])] });
		await device.hideKeyboard();
		expect(driver.callsOf("key")).toHaveLength(0);
		expect(driver.callsOf("pressButton")).toHaveLength(0);
	});
});

describe("device.settle", () => {
	test("uses the driver's settle", async () => {
		const { driver, device } = setup();
		expect(await device.settle({ quietMs: 100, timeout: 900 })).toEqual({ quiet: true, waitedMs: 0 });
		expect(driver.callsOf("settle")[0]?.opts).toEqual({ quietMs: 100, timeoutMs: 900 });
	});

	test("falls back to snapshot-hash polling on E_UNSUPPORTED", async () => {
		const clock = fakeClock();
		const driver = fakeDriver({
			screens: [snapshotOf([el("text", { label: "a" })])],
			onCall: (c) => (c.method === "settle" ? failWith("E_UNSUPPORTED") : undefined),
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock });
		const outcome = await device.settle({ quietMs: 200, timeout: 2000 });
		expect(outcome.quiet).toBe(true);
		expect(driver.callsOf("snapshot").length).toBeGreaterThanOrEqual(2);
	});

	test("fallback reports not quiet while the screen keeps changing", async () => {
		const clock = fakeClock();
		let n = 0;
		const driver = fakeDriver({
			screens: () => snapshotOf([el("text", { label: `tick ${n++}` })]),
			onCall: (c) => (c.method === "settle" ? failWith("E_UNSUPPORTED") : undefined),
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock });
		const outcome = await device.settle({ quietMs: 200, timeout: 1000 });
		expect(outcome.quiet).toBe(false);
	});

	test("other driver failures throw", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (c) => (c.method === "settle" ? failWith("E_TIMEOUT") : undefined),
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env });
		const error = await device.settle().catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("TIMEOUT");
	});
});

describe("device.snapshot", () => {
	test("renders a header and one line per element", async () => {
		const { device } = setup({ screens: [snapshotOf([el("button", { label: "Sign in", id: "sign-in" })])] });
		const text = await device.snapshot();
		expect(text.split("\n")[0]).toContain("ios axbridge");
		expect(text).toContain('[button] "Sign in" id=sign-in');
	});

	test("interactiveOnly is passed to the driver and filters", async () => {
		const { device, driver } = setup({
			screens: [snapshotOf([el("text", { label: "plain" }), el("button", { label: "Go" })])],
		});
		const text = await device.snapshot({ interactiveOnly: true });
		expect(driver.callsOf("snapshot")[0]?.opts).toEqual({ interactiveOnly: true });
		expect(text).toContain('"Go"');
		expect(text).not.toContain("plain");
	});
});

describe("device.screenshot", () => {
	function withDir(): { dir: string; driver: FakeDriver; device: ReturnType<typeof createDevice> } {
		const dir = mkdtempSync(join(tmpdir(), "e2e-shot-"));
		const driver = fakeDriver({ screens: [snapshotOf([])] });
		const device = createDevice({ session: { out: dir, attemptDir: dir }, driver, env });
		return { dir, driver, device };
	}

	test("numbers screenshots under <attemptDir>/screenshots", async () => {
		const { dir, driver, device } = withDir();
		expect(await device.screenshot("Home screen")).toBe(join(dir, "screenshots", "001-home-screen.png"));
		expect(await device.screenshot("After tap!")).toBe(join(dir, "screenshots", "002-after-tap.png"));
		expect(driver.callsOf("screenshot").map((c) => c.opts?.path)).toEqual([
			join(dir, "screenshots", "001-home-screen.png"),
			join(dir, "screenshots", "002-after-tap.png"),
		]);
	});

	test("a second device on the same attempt continues the numbering from disk", async () => {
		const { dir, device } = withDir();
		await device.screenshot("a");
		await Bun.write(join(dir, "screenshots", "002-b.png"), "x");
		expect(await device.screenshot("c")).toBe(join(dir, "screenshots", "003-c.png"));
	});

	test("writes the bytes itself when the driver returns a png", async () => {
		const dir = mkdtempSync(join(tmpdir(), "e2e-shot-"));
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (c) => (c.method === "screenshot" ? { data: { png: new Uint8Array([1, 2, 3]) } } : undefined),
		});
		const device = createDevice({ session: { out: dir, attemptDir: dir }, driver, env });
		const path = await device.screenshot("raw");
		expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
	});

	test("records a trace screenshot event", async () => {
		const dir = mkdtempSync(join(tmpdir(), "e2e-shot-"));
		const events: unknown[] = [];
		const driver = fakeDriver({ screens: [snapshotOf([])] });
		const device = createDevice({
			session: { out: dir, attemptDir: dir, trace: { write: (e) => events.push(e) } },
			driver,
			env,
		});
		const path = await device.screenshot("x");
		expect(events).toEqual([expect.objectContaining({ type: "screenshot", label: "x", path })]);
	});
});

describe("device misc", () => {
	test("devtools is undefined without a Metro URL", () => {
		expect(setup().device.devtools).toBeUndefined();
	});

	test("an aborted signal fails calls with TIMEOUT", async () => {
		const controller = new AbortController();
		controller.abort();
		const { device, driver } = setup({ session: { signal: controller.signal } });
		const error = await device.home().catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("TIMEOUT");
		expect(driver.calls).toHaveLength(0);
	});
});
