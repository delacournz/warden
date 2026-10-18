import { afterEach, describe, expect, test } from "bun:test";
import type { Driver, DriverResult } from "../driver.types";
import { canDetectAlerts } from "../observation-cache";
import { settleDetailOf } from "../settle";
import { canRepeatKeys, canSelectAll } from "../typing";
import { openAndroidDriver } from "./android-driver";
import { fakeAndroidHost, type ShellRule } from "./android-host.testing";
import { type AndroidStateStore, memoryAndroidState } from "./android-state";
import { type FakeUiadOptions, fakeUiad } from "./uiad.testing";
import { uiadBuildId } from "./uiad-device";
import { SYNTHETIC_FORM_DUMP } from "./uiautomator.fixture";

const probe = (sdk: number): string => `1\n${sdk}\nPhysical size: 1080x2400\nPhysical density: 420\n`;

const open: Driver[] = [];

type Setup = { sdk?: number; uiad?: FakeUiadOptions | false; state?: AndroidStateStore; shell?: ShellRule[] };

/** A driver over a fake shell and, unless `uiad: false`, an in-process `warden-uiad` that answers from the recorded session. */
async function setup(opts: Setup = {}) {
	const host = fakeAndroidHost({
		shell: [
			...(opts.shell ?? []),
			{ match: "getprop sys.boot_completed", reply: probe(opts.sdk ?? 37) },
			{ match: "[ -f", reply: "present\n" },
			{ match: "uiautomator dump /dev/stdout", reply: SYNTHETIC_FORM_DUMP },
		],
	});
	const uiad = fakeUiad(opts.uiad === false ? {} : (opts.uiad ?? {}));
	let t = 0;
	const clock = {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
	};
	const lines: string[] = [];
	const res = await openAndroidDriver({
		serial: "emulator-5554",
		adb: "adb",
		exec: host.exec,
		spawn: host.spawn,
		execBinary: host.execBinary,
		log: (line) => lines.push(line),
		clock,
		...(opts.uiad === false
			? {}
			: { uiad: { spawn: uiad.spawn, push: async () => ({ exitCode: 0, output: "" }), readyTimeoutMs: 200 } }),
		...(opts.state ? { state: opts.state } : {}),
	});
	if (!res.success) throw new Error(`open failed: ${res.error.code} ${res.error.message}`);
	open.push(res.data);
	return { driver: res.data, host, uiad, lines, clock };
}

afterEach(async () => {
	await Promise.all(open.splice(0).map((d) => d.close()));
});

async function value<T>(p: DriverResult<T>): Promise<T> {
	const r = await p;
	if (!r.success) throw new Error(`${r.error.code}: ${r.error.message}`);
	return r.data;
}

const dumps = (host: { shell: string[] }): number => host.shell.filter((c) => c.startsWith("uiautomator dump")).length;
const inputs = (host: { shell: string[] }): string[] => host.shell.filter((c) => c.startsWith("input "));

describe("off by default", () => {
	test("without the option nothing changes: dump, input, and the old capabilities", async () => {
		const { driver, host } = await setup({ uiad: false });
		expect(driver.capabilities).toMatchObject({ unicodeText: false, nativeSettle: false });
		await value(driver.snapshot());
		await value(driver.tap({ x: 10, y: 20 }));
		expect(dumps(host)).toBe(1);
		expect(inputs(host)).toEqual(["input tap 10 20"]);
		expect(canSelectAll(driver)).toBe(true);
	});

	test("an Android that predates the server's API level keeps the dump, whatever was asked", async () => {
		const { driver, uiad, host } = await setup({ sdk: 24 });
		await value(driver.snapshot());
		await value(driver.tap({ x: 1, y: 2 }));
		expect(uiad.started()).toBe(0);
		expect(dumps(host)).toBe(1);
		expect(driver.capabilities.nativeSettle).toBe(false);
		expect(canSelectAll(driver)).toBe(false);
	});
});

describe("with the server", () => {
	test("reports what it can do: native settle, unicode text, and select-all on any level it runs on", async () => {
		const { driver } = await setup({ sdk: 30 });
		expect(driver.capabilities).toMatchObject({ unicodeText: true, nativeSettle: true });
		expect(canSelectAll(driver)).toBe(true);
	});

	test("reports pinch and two pointers", async () => {
		const { driver } = await setup({ sdk: 30 });
		expect(driver.capabilities).toMatchObject({ pinch: true, maxPointers: 2 });
	});

	test("pinch is one gesture request with the radius in pixels (100 x the screen scale)", async () => {
		const { driver, uiad, host } = await setup({
			uiad: {
				handle: (request) =>
					request.op === "gesture" ? { data: { frames: 2, pointers: 2, maxLagMs: 0, via: "inject3" } } : undefined,
			},
		});
		await value(driver.pinch({ x: 540, y: 1200 }, 2, { angle: 0 }));
		const request = uiad.of("gesture")[0];
		const paths = request?.paths as Array<Array<{ x: number; y: number }>>;
		expect(paths).toHaveLength(2);
		const radius = 100 * (420 / 160);
		expect(paths[0]?.[0]?.x).toBeCloseTo(540 - radius, 1);
		expect(paths[1]?.[0]?.x).toBeCloseTo(540 + radius, 1);
		expect(paths[1]?.at(-1)?.x).toBeCloseTo(540 + radius * 2, 1);
		expect(inputs(host).filter((c) => c.includes("motionevent"))).toEqual([]);
	});

	test("a refused two-finger gesture is E_UNSUPPORTED, not a one-finger line; a refused one-finger path is the motionevent line", async () => {
		const { driver, host } = await setup({
			uiad: {
				handle: (request) =>
					request.op === "gesture" ? { error: { code: "E_HID", message: "no", retryable: false } } : undefined,
			},
		});
		const two = await driver.rotate({ x: 540, y: 1200 }, 90);
		expect(!two.success && two.error.code).toBe("E_UNSUPPORTED");
		await value(
			driver.gesture([
				{
					points: [
						{ x: 1, y: 2 },
						{ x: 30, y: 40 },
					],
				},
			])
		);
		expect(inputs(host).some((c) => c.includes("motionevent DOWN 1 2"))).toBe(true);
	});

	test("is not started until a call needs it: opening a link, or nothing at all, costs nothing", async () => {
		const { driver, uiad, host } = await setup();
		expect(uiad.started()).toBe(0);
		await value(driver.app.openUrl("myapp://home"));
		expect(uiad.started()).toBe(0);
		await value(driver.snapshot());
		expect(uiad.started()).toBe(1);
		expect(host.shell.some((c) => c.startsWith("[ -f"))).toBe(true);
	});

	test("snapshot comes from the server: no dump is run", async () => {
		const { driver, host, uiad } = await setup();
		const snapshot = await value(driver.snapshot());
		expect(snapshot.backend).toBe("uiautomator");
		expect(snapshot.flat.length).toBeGreaterThan(20);
		expect(dumps(host)).toBe(0);
		expect(uiad.of("snapshot")).toHaveLength(1);
	});

	test("every hit-test and alert read is a fresh look at the screen", async () => {
		const { driver, uiad } = await setup();
		await value(driver.elementAtPoint({ x: 10, y: 10 }));
		await value(driver.elementAtPoint({ x: 10, y: 10 }));
		await value(driver.alert());
		expect(uiad.of("snapshot")).toHaveLength(3);
	});

	test("an alert is read out of a server snapshot as out of a dump", async () => {
		const { driver } = await setup();
		if (!canDetectAlerts(driver)) throw new Error("no alertIn");
		const snapshot = await value(driver.snapshot());
		expect(driver.alertIn(snapshot)).toBeNull();
	});

	test("settle is the server's stream, one request, and no dump", async () => {
		const { driver, host, uiad } = await setup();
		const outcome = settleDetailOf(await value(driver.settle({ quietMs: 250 })));
		expect(outcome).toMatchObject({ quiet: true, via: "stream" });
		expect(uiad.of("settle")[0]).toMatchObject({ quietMs: 250, timeoutMs: 3000 });
		expect(dumps(host)).toBe(0);
	});

	test("a long quiet window is the server's too, not polled dumps", async () => {
		const { driver, host, uiad } = await setup();
		await value(driver.settle({ quietMs: 2000, timeoutMs: 5000 }));
		expect(uiad.of("settle")[0]).toMatchObject({ quietMs: 2000, timeoutMs: 5000 });
		expect(dumps(host)).toBe(0);
	});

	test("taps, long presses, swipes, drags and keys are the server's: no `input` process is started", async () => {
		const { driver, host, uiad } = await setup();
		await value(driver.tap({ x: 10, y: 20 }));
		await value(driver.tap({ x: 10, y: 20 }, { count: 2 }));
		await value(driver.longPress({ x: 5, y: 6 }));
		await value(driver.swipe({ x: 1, y: 2 }, { x: 3, y: 4 }));
		await value(driver.drag({ x: 1, y: 2 }, { x: 3, y: 4 }));
		await value(driver.key("Backspace"));
		await value(driver.pressButton("home"));
		expect(inputs(host)).toEqual([]);
		expect(uiad.of("tap")).toHaveLength(3);
		expect(uiad.of("swipe")).toHaveLength(2);
		expect(uiad.of("key").map((r) => r.keyCode)).toEqual([67, 3]);
	});

	test("a key with a modifier is still `input keycombination`", async () => {
		const { driver, host } = await setup();
		await value(driver.key("Tab", ["shift"]));
		expect(inputs(host)).toEqual(["input keycombination 59 61"]);
	});

	test("repeated keys are one request", async () => {
		const { driver, host, uiad } = await setup();
		if (!canRepeatKeys(driver)) throw new Error("no repeat");
		await value(driver.pressKeyRepeat("Backspace", 12));
		expect(uiad.of("key")[0]).toMatchObject({ keyCode: 67, times: 12 });
		expect(inputs(host)).toEqual([]);
	});

	test("typed text is inserted by the server, with or without a field that held something", async () => {
		const { driver, host, uiad } = await setup({
			uiad: { handle: (r) => (r.op === "typeText" ? { data: { text: "héllo", caret: 5 } } : undefined) },
		});
		await value(driver.typeText("héllo"));
		expect(uiad.of("typeText")[0]).toMatchObject({ text: "héllo" });
		expect(inputs(host)).toEqual([]);
	});

	test("text with nothing focused goes to `input text`, as before", async () => {
		const { driver, host } = await setup();
		await value(driver.typeText("abc"));
		expect(inputs(host)).toEqual(["input text abc"]);
	});

	test("select-all with nothing focused falls back to Ctrl+A where the device has it", async () => {
		const { driver, host } = await setup({ sdk: 34 });
		if (!canSelectAll(driver)) throw new Error("no selectAll");
		await value(driver.selectAll());
		expect(inputs(host)).toEqual(["input keycombination 113 29"]);
	});

	test("select-all with nothing focused on an older device is refused, and the caller backspaces instead", async () => {
		const { driver, host } = await setup({ sdk: 30 });
		if (!canSelectAll(driver)) throw new Error("no selectAll");
		const selected = await driver.selectAll();
		expect(selected.success).toBe(false);
		expect(inputs(host)).toEqual([]);
	});

	test("health says whether the server is up", async () => {
		const { driver } = await setup();
		const before = await value(driver.health());
		expect(before.detail).toMatchObject({ uiad: "idle" });
		await value(driver.snapshot());
		expect((await value(driver.health())).detail).toMatchObject({ uiad: "up" });
	});

	test("close ends the server before the shell", async () => {
		const { driver, uiad } = await setup();
		await value(driver.snapshot());
		expect(uiad.running()).toBe(1);
		await driver.close();
		expect(uiad.running()).toBe(0);
	});
});

describe("fallbacks", () => {
	test("a server that cannot start leaves every call to the dump and `input`, and does not stay on the hook", async () => {
		const { driver, host, uiad, lines } = await setup({ uiad: { exitBeforeReady: 1, stderr: ["no such class"] } });
		await value(driver.snapshot());
		await value(driver.snapshot());
		await value(driver.tap({ x: 1, y: 2 }));
		expect(dumps(host)).toBe(2);
		expect(inputs(host)).toEqual(["input tap 1 2"]);
		expect(uiad.started()).toBe(2);
		expect(driver.capabilities.nativeSettle).toBe(false);
		expect(lines.some((l) => l.includes("using uiautomator dump and input"))).toBe(true);
	});

	test("a start that can never work is written down for the build, and the next driver does not try", async () => {
		const state = memoryAndroidState();
		const first = await setup({ state, uiad: { protocol: 2 } });
		await value(first.driver.snapshot());
		await first.driver.close();
		expect((await state.read("emulator-5554")).uiadUnsupported).toBe(uiadBuildId());

		const second = await setup({ state });
		await value(second.driver.snapshot());
		expect(second.uiad.started()).toBe(0);
		expect(dumps(second.host)).toBe(1);
		expect(second.driver.capabilities.nativeSettle).toBe(false);
	});

	test("a server that dies on a snapshot is stopped before the dump runs, then started again next time", async () => {
		let killed = false;
		const { driver, host, uiad } = await setup({
			uiad: {
				handle: (request) => {
					if (request.op !== "snapshot" || killed) return undefined;
					killed = true;
					return "die";
				},
			},
		});
		await value(driver.snapshot());
		expect(dumps(host)).toBe(1);
		expect(uiad.running()).toBe(0);
		await value(driver.snapshot());
		expect(dumps(host)).toBe(1);
		expect(uiad.started()).toBe(2);
	});

	test("a settle on a server that died falls back to the dump-based settle", async () => {
		const { driver, host } = await setup({ uiad: { handle: (r) => (r.op === "settle" ? "die" : undefined) } });
		const outcome = settleDetailOf(await value(driver.settle({ quietMs: 250 })));
		expect(outcome.via).toBe("snapshot");
		expect(dumps(host)).toBe(1);
	});

	test("an `input` the server refuses is done by `input`", async () => {
		const { driver, host } = await setup({
			uiad: {
				handle: (r) =>
					r.op === "key" ? { error: { code: "E_HID", message: "refused", retryable: false } } : undefined,
			},
		});
		await value(driver.key("Enter"));
		expect(inputs(host)).toEqual(["input keyevent 66"]);
	});

	test("a tap whose server died is a failed step, not a second tap", async () => {
		const { driver, host } = await setup({ uiad: { handle: (r) => (r.op === "tap" ? "die" : undefined) } });
		const tapped = await driver.tap({ x: 1, y: 2 });
		expect(tapped.success).toBe(false);
		expect(inputs(host)).toEqual([]);
	});
});

describe("another UiAutomation client", () => {
	const busy = {
		code: "E_AX_UNAVAILABLE",
		message: "UiAutomationService already registered!",
		retryable: false,
		detail: { reason: "uiautomation_busy" },
	};
	const maestro =
		" 3120 app_process /system/bin com.android.commands.am.Am instrument -w dev.mobile.maestro.test/androidx.test.runner.AndroidJUnitRunner";

	test("is named in the error, and the dump is not tried: it would only be Killed", async () => {
		const { driver, host } = await setup({
			uiad: { fatal: busy },
			shell: [{ match: "ps -A -o PID,ARGS", reply: `PID ARGS\n${maestro}\n` }],
		});
		const taken = await driver.snapshot();
		expect(taken.success).toBe(false);
		if (taken.success) return;
		expect(taken.error.code).toBe("E_AX_UNAVAILABLE");
		expect(taken.error.message).toContain("pid 3120");
		expect(dumps(host)).toBe(0);
		expect(host.shell.some((c) => c.startsWith("kill"))).toBe(false);
	});

	test("inputs still work, because `input` does not need UiAutomation", async () => {
		const { driver, host } = await setup({
			uiad: { fatal: busy },
			shell: [{ match: "ps -A -o PID,ARGS", reply: `PID ARGS\n${maestro}\n` }],
		});
		await value(driver.tap({ x: 3, y: 4 }));
		expect(inputs(host)).toEqual(["input tap 3 4"]);
	});
});
