import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, DriverResult } from "../driver.types";
import { elementAt, openAndroidDriver } from "./android-driver";
import { fakeAndroidHost, type HostRule, PNG_BYTES, type ShellRule } from "./android-host.testing";
import { parseUiautomatorXml } from "./uiautomator";
import { SYNTHETIC_FORM_DUMP, SYNTHETIC_FORM_SCREEN } from "./uiautomator.fixture";

const SCREEN = { width: 1080, height: 2400, scale: 2.625 };

function fakeClock() {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
		advance: (ms: number) => {
			t += ms;
		},
	};
}

const BASE_RULES: ShellRule[] = [
	{ match: "getprop sys.boot_completed", reply: "1\n" },
	{ match: "wm size", reply: "Physical size: 1080x2400\n" },
	{ match: "wm density", reply: "Physical density: 420\n" },
	{ match: "uiautomator dump /dev/stdout", reply: `${SYNTHETIC_FORM_DUMP}` },
];

const open: Driver[] = [];

async function setup(opts: { shell?: ShellRule[]; host?: HostRule[]; screen?: boolean } = {}) {
	const host = fakeAndroidHost({
		shell: [...(opts.shell ?? []), ...BASE_RULES],
		...(opts.host ? { host: opts.host } : {}),
	});
	const lines: string[] = [];
	const clock = fakeClock();
	const res = await openAndroidDriver({
		serial: "emulator-5554",
		adb: "adb",
		exec: host.exec,
		spawn: host.spawn,
		execBinary: host.execBinary,
		log: (l) => lines.push(l),
		clock,
		...(opts.screen ? { screen: SCREEN } : {}),
	});
	if (!res.success) throw new Error(`open failed: ${res.error.code} ${res.error.message}`);
	open.push(res.data);
	return { driver: res.data, host, lines, clock };
}

afterEach(async () => {
	await Promise.all(open.splice(0).map((d) => d.close()));
});

async function value<T>(p: DriverResult<T>): Promise<T> {
	const r = await p;
	if (!r.success) throw new Error(`${r.error.code}: ${r.error.message}`);
	return r.data;
}

describe("open", () => {
	test("waits for boot, reads the screen, turns animations off", async () => {
		const { driver, host } = await setup();
		expect(driver.platform).toBe("android");
		expect(driver.id).toBe("emulator-5554");
		expect(host.shell.slice(0, 3)).toEqual(["getprop sys.boot_completed", "wm size", "wm density"]);
		expect(host.shell.slice(3)).toEqual([
			"settings put global window_animation_scale 0",
			"settings put global transition_animation_scale 0",
			"settings put global animator_duration_scale 0",
		]);
	});

	test("a supplied screen skips wm", async () => {
		const { host } = await setup({ screen: true });
		expect(host.shell.some((c) => c.startsWith("wm"))).toBe(false);
	});

	test("E_NOT_BOOTED when sys.boot_completed never reaches 1", async () => {
		const host = fakeAndroidHost({ shell: [{ match: "getprop sys.boot_completed", reply: "\n" }] });
		const clock = fakeClock();
		const res = await openAndroidDriver({
			serial: "s",
			adb: "adb",
			exec: host.exec,
			spawn: host.spawn,
			clock,
			bootTimeoutMs: 3000,
		});
		expect(!res.success && res.error.code).toBe("E_NOT_BOOTED");
	});

	test("capabilities", async () => {
		const { driver } = await setup();
		expect(driver.capabilities).toEqual({
			pinch: false,
			unicodeText: false,
			nativeSettle: false,
			alerts: true,
			reachability: true,
		});
	});
});

describe("snapshot", () => {
	test("returns the parsed tree with uiautomator backend and screen", async () => {
		const { driver } = await setup();
		const snap = await value(driver.snapshot());
		expect(snap.platform).toBe("android");
		expect(snap.backend).toBe("uiautomator");
		expect(snap.screen).toMatchObject({ width: 1080, height: 2400, scale: 2.625, rotation: 0 });
		expect(snap.flat.some((e) => e.identifier === "login-button")).toBe(true);
		expect(snap.truncated).toBe(false);
	});

	test("interactiveOnly filters", async () => {
		const { driver } = await setup();
		const full = await value(driver.snapshot());
		const slim = await value(driver.snapshot({ interactiveOnly: true }));
		expect(slim.flat.length).toBeLessThan(full.flat.length);
		expect(slim.flat.some((e) => e.text === "Static footer")).toBe(false);
		expect(slim.flat.some((e) => e.identifier === "email-input")).toBe(true);
	});

	test("another backend is E_UNSUPPORTED", async () => {
		const { driver } = await setup();
		const res = await driver.snapshot({ backend: "ax" });
		expect(!res.success && res.error.code).toBe("E_UNSUPPORTED");
	});

	test("a landscape dump swaps the screen dimensions", async () => {
		const landscape = SYNTHETIC_FORM_DUMP.replace('rotation="0"', 'rotation="1"');
		const { driver } = await setup({ shell: [{ match: "uiautomator dump /dev/stdout", reply: landscape }] });
		const snap = await value(driver.snapshot());
		expect(snap.screen).toMatchObject({ width: 2400, height: 1080, rotation: 1 });
	});

	test("route fallback goes stdout -> tty -> file and is remembered", async () => {
		const { driver, host } = await setup({
			shell: [{ match: "uiautomator dump /dev/stdout", reply: "UI hierchary dumped to: /dev/stdout\n" }],
			host: [{ match: /exec-out uiautomator dump \/dev\/tty$/, reply: SYNTHETIC_FORM_DUMP }],
		});
		await value(driver.snapshot());
		await value(driver.snapshot());
		expect(host.host.filter((a) => a.includes("exec-out")).length).toBe(2);
		expect(host.shell.filter((c) => c === "uiautomator dump /dev/stdout").length).toBe(1);
		const health = await value(driver.health());
		expect(health.detail?.dumpRoute).toBe("tty");
	});

	test("an unusable dump is E_AX_UNAVAILABLE (retryable)", async () => {
		const bad = "ERROR: null root node returned by UiTestAutomationBridge.\n";
		const { driver } = await setup({
			shell: [{ match: "uiautomator", reply: bad }],
			host: [{ match: "adb", reply: bad }],
		});
		const res = await driver.snapshot();
		expect(!res.success && res.error.code).toBe("E_AX_UNAVAILABLE");
		expect(!res.success && res.error.retryable).toBe(true);
	});
});

describe("elementAtPoint", () => {
	test("picks the deepest hittable element", async () => {
		const { driver } = await setup();
		const el = await value(driver.elementAtPoint({ x: 540, y: 760 }));
		expect(el?.identifier).toBe("login-button");
	});

	test("falls back to the deepest element when nothing is hittable, null outside everything", async () => {
		const { driver } = await setup();
		expect((await value(driver.elementAtPoint({ x: 100, y: 140 })))?.text).toBe("Sign in");
		const off = await value(driver.elementAtPoint({ x: 5000, y: 5000 }));
		expect(off).toBeNull();
	});

	test("reuses a fresh snapshot instead of dumping again", async () => {
		const { driver, host } = await setup();
		await value(driver.snapshot());
		await value(driver.elementAtPoint({ x: 1, y: 1 }));
		expect(host.shell.filter((c) => c.includes("uiautomator dump")).length).toBe(1);
	});

	test("elementAt prefers later siblings at equal depth", () => {
		const { flat } = parseUiautomatorXml(SYNTHETIC_FORM_DUMP, SYNTHETIC_FORM_SCREEN);
		expect(elementAt(flat, { x: 540, y: 280 })?.identifier).toBe("email-input");
	});
});

describe("input", () => {
	test("tap, multi-tap, hold and latency log", async () => {
		const { driver, host, lines } = await setup();
		await value(driver.tap({ x: 100.4, y: 200.6 }));
		await value(driver.tap({ x: 10, y: 20 }, { count: 2 }));
		await value(driver.tap({ x: 10, y: 20 }, { durationMs: 900 }));
		const cmds = host.shell.filter((c) => c.startsWith("input"));
		expect(cmds).toEqual(["input tap 100 201", "input tap 10 20; input tap 10 20", "input swipe 10 20 10 20 900"]);
		expect(lines.some((l) => /^tap 100,201 x1 in \d+ms$/.test(l))).toBe(true);
	});

	test("longPress, swipe, drag", async () => {
		const { driver, host } = await setup();
		await value(driver.longPress({ x: 1, y: 2 }));
		await value(driver.longPress({ x: 1, y: 2 }, { durationMs: 1000 }));
		await value(driver.swipe({ x: 1, y: 2 }, { x: 3, y: 4 }, { durationMs: 200 }));
		await value(driver.drag({ x: 1, y: 2 }, { x: 3, y: 4 }, { pressMs: 400, durationMs: 300, releaseMs: 100 }));
		await value(driver.drag({ x: 1, y: 2 }, { x: 3, y: 4 }));
		expect(host.shell.filter((c) => c.startsWith("input"))).toEqual([
			"input swipe 1 2 1 2 600",
			"input swipe 1 2 1 2 1000",
			"input swipe 1 2 3 4 200",
			"input swipe 1 2 3 4 800",
			"input swipe 1 2 3 4 1100",
		]);
	});

	test("a failing input command is E_HID", async () => {
		const { driver } = await setup({
			shell: [{ match: "input tap", reply: { stdout: "Error: no display\n", exitCode: 1 } }],
		});
		const res = await driver.tap({ x: 1, y: 1 });
		expect(!res.success && res.error.code).toBe("E_HID");
	});

	test("typeText: ASCII is escaped, non-ASCII is E_UNSUPPORTED_TEXT, empty is a no-op", async () => {
		const { driver, host } = await setup();
		await value(driver.typeText("hi there"));
		await value(driver.typeText(""));
		expect(host.shell.filter((c) => c.startsWith("input text"))).toEqual(["input text hi%sthere"]);
		const bad = await driver.typeText("héllo");
		expect(!bad.success && bad.error.code).toBe("E_UNSUPPORTED_TEXT");
		expect(host.shell.filter((c) => c.startsWith("input text")).length).toBe(1);
	});

	test("key and modifiers", async () => {
		const { driver, host } = await setup();
		await value(driver.key("Enter"));
		await value(driver.key("Backspace"));
		await value(driver.key("Tab", ["shift"]));
		expect(host.shell.filter((c) => c.startsWith("input"))).toEqual([
			"input keyevent 66",
			"input keyevent 67",
			"input keycombination 59 61",
		]);
	});

	test("modifier keys on an old Android are E_UNSUPPORTED", async () => {
		const { driver } = await setup({
			shell: [{ match: "input keycombination", reply: { stdout: "Error: Unknown command\n", exitCode: 255 } }],
		});
		const res = await driver.key("Tab", ["ctrl"]);
		expect(!res.success && res.error.code).toBe("E_UNSUPPORTED");
	});

	test("pressButton maps to keycodes; shake is E_UNSUPPORTED", async () => {
		const { driver, host } = await setup();
		for (const b of ["home", "back", "volumeUp", "volumeDown", "lock"] as const) await value(driver.pressButton(b));
		expect(host.shell.filter((c) => c.startsWith("input"))).toEqual([
			"input keyevent 3",
			"input keyevent 4",
			"input keyevent 24",
			"input keyevent 25",
			"input keyevent 26",
		]);
		const shake = await driver.pressButton("shake");
		expect(!shake.success && shake.error.code).toBe("E_UNSUPPORTED");
	});

	test("pinch and clipboard are E_UNSUPPORTED", async () => {
		const { driver } = await setup();
		const pinch = await driver.pinch({ x: 1, y: 1 }, 2);
		expect(!pinch.success && pinch.error.code).toBe("E_UNSUPPORTED");
		const clip = await driver.clipboard("x");
		expect(!clip.success && clip.error.code).toBe("E_UNSUPPORTED");
		expect((await driver.clipboard()).success).toBe(false);
	});
});

describe("screenshot", () => {
	test("bytes come from host exec-out, never the session", async () => {
		const { driver, host } = await setup();
		const shot = await value(driver.screenshot());
		expect(shot.png).toEqual(PNG_BYTES);
		expect(host.host).toContainEqual(["adb", "-s", "emulator-5554", "exec-out", "screencap", "-p"]);
		expect(host.shell.some((c) => c.includes("screencap"))).toBe(false);
	});

	test("path writes the file", async () => {
		const { driver } = await setup();
		const dir = mkdtempSync(join(tmpdir(), "wdn-shot-"));
		const path = join(dir, "nested", "a.png");
		const shot = await value(driver.screenshot({ path }));
		expect(shot).toEqual({ path });
		expect(new Uint8Array(readFileSync(path))).toEqual(PNG_BYTES);
	});

	test("non-PNG output is E_IO", async () => {
		const host = fakeAndroidHost({ shell: BASE_RULES, screencap: new Uint8Array([1, 2, 3]) });
		const res = await openAndroidDriver({
			serial: "s",
			adb: "adb",
			exec: host.exec,
			spawn: host.spawn,
			execBinary: host.execBinary,
			clock: fakeClock(),
		});
		if (!res.success) throw new Error("open");
		open.push(res.data);
		const shot = await res.data.screenshot();
		expect(!shot.success && shot.error.code).toBe("E_IO");
	});
});

describe("device state", () => {
	test("orientation get and set", async () => {
		const { driver, host } = await setup({ shell: [{ match: "settings get system user_rotation", reply: "1\n" }] });
		expect(await value(driver.orientation())).toBe("landscapeLeft");
		expect(await value(driver.orientation("portrait"))).toBe("portrait");
		expect(host.shell.filter((c) => c.startsWith("settings put system"))).toEqual([
			"settings put system accelerometer_rotation 0",
			"settings put system user_rotation 0",
		]);
	});

	test("orientation 'null' (never set) reads as portrait", async () => {
		const { driver } = await setup({ shell: [{ match: "settings get system user_rotation", reply: "null\n" }] });
		expect(await value(driver.orientation())).toBe("portrait");
	});

	test("appearance get and set", async () => {
		const { driver, host } = await setup({ shell: [{ match: "cmd uimode night", reply: "Night mode: yes\n" }] });
		expect(await value(driver.appearance())).toBe("dark");
		expect(await value(driver.appearance("light"))).toBe("light");
		expect(host.shell).toContain("cmd uimode night no");
	});

	test("health", async () => {
		const { driver } = await setup({
			shell: [
				{ match: "getprop ro.build.version.release", reply: "14\n" },
				{ match: "getprop ro.build.version.sdk", reply: "34\n" },
				{ match: "getprop ro.product.model", reply: "sdk_gphone64_arm64\n" },
			],
		});
		const h = await value(driver.health());
		expect(h).toMatchObject({
			platform: "android",
			id: "emulator-5554",
			version: "Android 14 (sdk 34)",
			transport: "adb",
		});
		expect(h.detail?.model).toBe("sdk_gphone64_arm64");
	});
});

describe("settle and alert", () => {
	test("settle is implemented here via snapshot hashing", async () => {
		const { driver } = await setup();
		const out = await value(driver.settle({ quietMs: 100, timeoutMs: 2000 }));
		expect(out.quiet).toBe(true);
		expect(out.waitedMs).toBeGreaterThanOrEqual(100);
	});

	test("settle gives up when the UI keeps changing", async () => {
		let n = 0;
		const { driver } = await setup({
			shell: [
				{
					match: "uiautomator dump /dev/stdout",
					reply: () => SYNTHETIC_FORM_DUMP.replace("Sign in", `Sign in ${++n}`),
				},
			],
		});
		const out = await value(driver.settle({ quietMs: 100, timeoutMs: 400 }));
		expect(out.quiet).toBe(false);
	});

	test("alert returns null on a normal screen and the dialog when present", async () => {
		const { driver } = await setup();
		expect(await value(driver.alert())).toBeNull();
		const dialog =
			'<?xml version="1.0"?><hierarchy rotation="0"><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" enabled="true" clickable="false">' +
			'<node class="android.widget.Button" resource-id="android:id/button1" text="OK" bounds="[0,0][100,100]" enabled="true" clickable="true" />' +
			"</node></hierarchy>";
		const { driver: d2 } = await setup({ shell: [{ match: "uiautomator dump /dev/stdout", reply: dialog }] });
		const alert = await value(d2.alert());
		expect(alert?.buttons.map((b) => b.text)).toEqual(["OK"]);
	});
});

describe("app commands and close", () => {
	test("app.* is wired to the session and host adb", async () => {
		const { driver, host } = await setup({ host: [{ match: "adb -s emulator-5554 install", reply: "Success\n" }] });
		await value(driver.app.install("/x.apk"));
		await value(driver.app.terminate("com.x"));
		expect(host.host).toContainEqual(["adb", "-s", "emulator-5554", "install", "-r", "/x.apk"]);
		expect(host.shell).toContain("am force-stop com.x");
	});

	test("close shuts the shell and is idempotent", async () => {
		const { driver } = await setup();
		await driver.close();
		await driver.close();
		const res = await driver.tap({ x: 1, y: 1 });
		expect(res.success).toBe(false);
	});
});
