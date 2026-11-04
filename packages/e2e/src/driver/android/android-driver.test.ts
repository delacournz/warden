import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, DriverResult } from "../driver.types";
import { canDetectAlerts } from "../observation-cache";
import { settleDetailOf } from "../settle";
import { canRepeatKeys, canSelectAll } from "../typing";
import { elementAt, openAndroidDriver } from "./android-driver";
import {
	type FakeAndroidHost,
	fakeAndroidHost,
	type HostRule,
	PNG_BYTES,
	type ShellRule,
} from "./android-host.testing";
import { type AndroidStateStore, memoryAndroidState } from "./android-state";
import { DUMPSYS_ONLINE } from "./network.fixture";
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

/** The boot probe's answer: boot flag, sdk level (omitted when `undefined`), wm size and density. */
function probe(sdk: number | undefined): string {
	return `1\n${sdk ?? ""}\nPhysical size: 1080x2400\nPhysical density: 420\n`;
}

const BASE_RULES: ShellRule[] = [
	{ match: "getprop sys.boot_completed", reply: probe(34) },
	{ match: "uiautomator dump /dev/stdout", reply: `${SYNTHETIC_FORM_DUMP}` },
];

const open: Driver[] = [];

async function setup(
	opts: {
		shell?: ShellRule[];
		host?: HostRule[];
		screen?: boolean;
		state?: AndroidStateStore;
		appPackage?: string;
		serial?: string;
		ownedPackages?: readonly string[];
		dumpRoute?: "stdout" | "tty" | "file";
		onDumpRoute?: (route: "stdout" | "tty" | "file") => void;
	} = {}
) {
	const host = fakeAndroidHost({
		shell: [...(opts.shell ?? []), ...BASE_RULES],
		...(opts.host ? { host: opts.host } : {}),
	});
	const lines: string[] = [];
	const clock = fakeClock();
	const res = await openAndroidDriver({
		serial: opts.serial ?? "emulator-5554",
		adb: "adb",
		exec: host.exec,
		spawn: host.spawn,
		execBinary: host.execBinary,
		log: (l) => lines.push(l),
		...(opts.ownedPackages ? { ownedPackages: opts.ownedPackages } : {}),
		clock,
		...(opts.screen ? { screen: SCREEN } : {}),
		...(opts.state ? { state: opts.state } : {}),
		...(opts.appPackage ? { appPackage: opts.appPackage } : {}),
		...(opts.dumpRoute ? { dumpRoute: opts.dumpRoute } : {}),
		...(opts.onDumpRoute ? { onDumpRoute: opts.onDumpRoute } : {}),
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
	test("one probe round trip for boot + screen, one command to read the animation scales and turn them off", async () => {
		const { driver, host } = await setup();
		expect(driver.platform).toBe("android");
		expect(driver.id).toBe("emulator-5554");
		expect(host.shell).toEqual([
			"getprop sys.boot_completed; getprop ro.build.version.sdk; wm size; wm density",
			"settings get global window_animation_scale; settings get global transition_animation_scale; settings get global animator_duration_scale; settings put global window_animation_scale 0; settings put global transition_animation_scale 0; settings put global animator_duration_scale 0",
		]);
	});

	test("an unparseable wm answer falls back to separate wm reads", async () => {
		const { host } = await setup({
			shell: [
				{ match: "getprop sys.boot_completed", reply: "1\n" },
				{ match: "wm size", reply: "Physical size: 1080x2400\n" },
			],
		});
		expect(host.shell.slice(0, 3)).toEqual([
			"getprop sys.boot_completed; getprop ro.build.version.sdk; wm size; wm density",
			"wm size",
			"wm density",
		]);
	});

	test("a remembered dump route is tried first and a new one is reported", async () => {
		const routes: string[] = [];
		const host = fakeAndroidHost({
			shell: [
				...BASE_RULES,
				{ match: "uiautomator dump /dev/stdout", reply: "UI hierchary dumped to: /dev/stdout\n" },
				{ match: /^rm -f \/sdcard\/warden-ui\.xml/, reply: SYNTHETIC_FORM_DUMP },
			],
			host: [{ match: "adb", reply: "ERROR: null root node\n" }],
		});
		const opened = await openAndroidDriver({
			serial: "s",
			adb: "adb",
			exec: host.exec,
			spawn: host.spawn,
			clock: fakeClock(),
			dumpRoute: "file",
			onDumpRoute: (r) => routes.push(r),
		});
		if (!opened.success) throw new Error("open");
		open.push(opened.data);
		await value(opened.data.snapshot());
		expect(host.shell.some((c) => c.includes("/dev/stdout"))).toBe(false);
		expect(host.host).toEqual([]);
		expect(routes).toEqual([]);
	});

	test("a supplied screen skips the wm fallback", async () => {
		const { host } = await setup({ screen: true, shell: [{ match: "getprop sys.boot_completed", reply: "1\n" }] });
		expect(host.shell.some((c) => c === "wm size")).toBe(false);
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
			maxPointers: 1,
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

	test("route fallback goes stdout -> tty -> file below API 30 and is remembered", async () => {
		const { driver, host } = await setup({
			shell: [
				{ match: "getprop sys.boot_completed", reply: probe(29) },
				{ match: "uiautomator dump /dev/stdout", reply: "UI hierchary dumped to: /dev/stdout\n" },
			],
			host: [{ match: /exec-out uiautomator dump \/dev\/tty$/, reply: SYNTHETIC_FORM_DUMP }],
		});
		await value(driver.snapshot());
		await value(driver.snapshot());
		expect(host.host.filter((a) => a.includes("exec-out")).length).toBe(2);
		expect(host.shell.filter((c) => c === "uiautomator dump /dev/stdout").length).toBe(1);
		const health = await value(driver.health());
		expect(health.detail?.dumpRoute).toBe("tty");
	});

	test("API 30+ probes tty first, so a working tty never runs the failing stdout dump", async () => {
		const { driver, host } = await setup({
			shell: [{ match: "uiautomator dump /dev/stdout", reply: "UI hierchary dumped to: /dev/stdout\n" }],
			host: [{ match: /exec-out uiautomator dump \/dev\/tty$/, reply: SYNTHETIC_FORM_DUMP }],
		});
		await value(driver.snapshot());
		expect(host.shell.filter((c) => c.includes("uiautomator dump"))).toEqual([]);
		expect(host.host.filter((a) => a.includes("exec-out")).length).toBe(1);
	});

	test("a transient 'null root node' is retried and then succeeds", async () => {
		let calls = 0;
		const bad = "ERROR: null root node returned by UiTestAutomationBridge.\n";
		const { driver, lines } = await setup({
			shell: [{ match: "uiautomator dump /dev/stdout", reply: () => (++calls < 3 ? bad : SYNTHETIC_FORM_DUMP) }],
			host: [{ match: "adb", reply: bad }],
		});
		const snap = await value(driver.snapshot());
		expect(snap.flat.length).toBeGreaterThan(10);
		expect(lines.some((l) => l.includes("retrying (1/2)"))).toBe(true);
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

	test("every hit-test dumps the screen itself, even right after a snapshot: a field confirm needs two real reads", async () => {
		const { driver, host } = await setup();
		await value(driver.snapshot());
		await value(driver.elementAtPoint({ x: 1, y: 1 }));
		await value(driver.elementAtPoint({ x: 1, y: 1 }));
		expect(host.shell.filter((c) => c.includes("uiautomator dump")).length).toBe(3);
	});

	test("a hit-test sees what the screen holds after typing, not an earlier dump", async () => {
		let typed = false;
		const { driver } = await setup({
			shell: [
				{
					match: "uiautomator dump /dev/stdout",
					reply: () => (typed ? SYNTHETIC_FORM_DUMP.replace("Sign in", "Typed") : SYNTHETIC_FORM_DUMP),
				},
				{
					match: "input text",
					reply: () => {
						typed = true;
						return "";
					},
				},
			],
		});
		await value(driver.snapshot());
		await value(driver.typeText("x"));
		expect((await value(driver.elementAtPoint({ x: 100, y: 140 })))?.text).toBe("Typed");
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

	test("longPress and swipe are single input swipes", async () => {
		const { driver, host } = await setup();
		await value(driver.longPress({ x: 1, y: 2 }));
		await value(driver.longPress({ x: 1, y: 2 }, { durationMs: 1000 }));
		await value(driver.swipe({ x: 1, y: 2 }, { x: 3, y: 4 }, { durationMs: 200 }));
		expect(host.shell.filter((c) => c.startsWith("input"))).toEqual([
			"input swipe 1 2 1 2 600",
			"input swipe 1 2 1 2 1000",
			"input swipe 1 2 3 4 200",
		]);
	});

	test("drag on sdk 26+ is hold-then-move: DOWN, 8 interpolated MOVEs, UP in one shell line", async () => {
		const { driver, host } = await setup();
		await value(driver.drag({ x: 0, y: 0 }, { x: 80, y: 160 }, { pressMs: 400, durationMs: 800, releaseMs: 100 }));
		const moves = Array.from(
			{ length: 8 },
			(_, i) => `input motionevent MOVE ${10 * (i + 1)} ${20 * (i + 1)} && sleep 0.100`
		);
		expect(host.shell.filter((c) => c.startsWith("input"))).toEqual([
			`input motionevent DOWN 0 0 && sleep 0.400 && ${moves.join(" && ")} && sleep 0.100 && input motionevent UP 80 160 || (input motionevent CANCEL 80 160; exit 1)`,
		]);
	});

	test("drag defaults hold 500 ms and move over 600 ms", async () => {
		const { driver, host } = await setup();
		await value(driver.drag({ x: 0, y: 0 }, { x: 8, y: 8 }));
		const cmd = host.shell.find((c) => c.startsWith("input motionevent"));
		expect(
			cmd?.startsWith("input motionevent DOWN 0 0 && sleep 0.500 && input motionevent MOVE 1 1 && sleep 0.075")
		).toBe(true);
		expect(cmd?.endsWith("sleep 0.000 && input motionevent UP 8 8 || (input motionevent CANCEL 8 8; exit 1)")).toBe(
			true
		);
	});

	test("a failing drag line is E_HID (the line itself lifts the finger with CANCEL)", async () => {
		const { driver } = await setup({
			shell: [{ match: "input motionevent", reply: { stdout: "Error\n", exitCode: 1 } }],
		});
		const res = await driver.drag({ x: 0, y: 0 }, { x: 8, y: 8 });
		expect(!res.success && res.error.code).toBe("E_HID");
	});

	test("drag falls back to one long input swipe below sdk 26 and when the sdk is unknown", async () => {
		for (const sdk of [25, undefined]) {
			const { driver, host } = await setup({ shell: [{ match: "getprop sys.boot_completed", reply: probe(sdk) }] });
			await value(driver.drag({ x: 1, y: 2 }, { x: 3, y: 4 }, { pressMs: 400, durationMs: 300, releaseMs: 100 }));
			await value(driver.drag({ x: 1, y: 2 }, { x: 3, y: 4 }));
			expect(host.shell.filter((c) => c.startsWith("input"))).toEqual([
				"input swipe 1 2 3 4 800",
				"input swipe 1 2 3 4 1100",
			]);
		}
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

	test("typeText splits around a literal %s and chains the pieces with &&", async () => {
		const { driver, host } = await setup();
		await value(driver.typeText("100% safe 50% off"));
		expect(host.shell.filter((c) => c.startsWith("input text"))).toEqual([
			"input text 100% && input text %ssafe%s50% && input text %soff",
		]);
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

	test("pressKeyRepeat batches presses into one command (the typing layer finds it)", async () => {
		const { driver, host } = await setup();
		expect(canRepeatKeys(driver)).toBe(true);
		if (!canRepeatKeys(driver)) return;
		await value(driver.pressKeyRepeat("Backspace", 13));
		await value(driver.pressKeyRepeat("Backspace", 0));
		expect(host.shell.filter((c) => c.startsWith("input"))).toEqual([
			`input keyevent ${Array(13).fill("67").join(" ")}`,
		]);
	});

	test("selectAll is Ctrl+A through keycombination on Android 13+ (the typing layer finds it)", async () => {
		const { driver, host } = await setup();
		expect(canSelectAll(driver)).toBe(true);
		if (!canSelectAll(driver)) return;
		await value(driver.selectAll());
		expect(host.shell.filter((c) => c.startsWith("input"))).toEqual(["input keycombination 113 29"]);
	});

	test("Android 12 and an unreadable sdk level have no selectAll, so the typing layer keeps its Backspaces", async () => {
		const old = await setup({ shell: [{ match: "getprop sys.boot_completed", reply: probe(32) }] });
		expect(canSelectAll(old.driver)).toBe(false);
		expect(canRepeatKeys(old.driver)).toBe(true);
		const unknown = await setup({ shell: [{ match: "getprop sys.boot_completed", reply: probe(undefined) }] });
		expect(canSelectAll(unknown.driver)).toBe(false);
		const edge = await setup({ shell: [{ match: "getprop sys.boot_completed", reply: probe(33) }] });
		expect(canSelectAll(edge.driver)).toBe(true);
	});

	test("a failing select-all is returned for the caller to fall back", async () => {
		const { driver } = await setup({
			shell: [{ match: "input keycombination", reply: { stdout: "Error: Unknown command\n", exitCode: 255 } }],
		});
		if (!canSelectAll(driver)) throw new Error("expected selectAll");
		expect((await driver.selectAll()).success).toBe(false);
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

	test("pinch and rotate need the server; a two-finger gesture is E_UNSUPPORTED without it", async () => {
		const { driver, host } = await setup();
		for (const res of [
			await driver.pinch({ x: 500, y: 500 }, 2),
			await driver.rotate({ x: 500, y: 500 }, 90),
			await driver.gesture([
				{
					points: [
						{ x: 1, y: 1 },
						{ x: 5, y: 5 },
					],
				},
				{
					points: [
						{ x: 9, y: 9 },
						{ x: 4, y: 4 },
					],
				},
			]),
		]) {
			expect(!res.success && res.error.code).toBe("E_UNSUPPORTED");
			expect(!res.success && /warden-uiad|at most 1 finger/.test(res.error.message)).toBe(true);
		}
		expect(host.shell.some((c) => c.includes("motionevent"))).toBe(false);
	});

	test("a one-finger gesture on sdk 26+ is one motionevent line, with a plan error returned as is", async () => {
		const { driver, host } = await setup();
		await value(
			driver.gesture(
				[
					{
						points: [
							{ x: 100, y: 200 },
							{ x: 300, y: 400 },
						],
					},
				],
				{ durationMs: 160, holdMs: 20 }
			)
		);
		const line = host.shell.find((c) => c.includes("motionevent"));
		expect(line).toStartWith("input motionevent DOWN 100 200 && sleep 0.020");
		expect(line).toContain("input motionevent UP 300 400 || (input motionevent CANCEL 300 400; exit 1)");
		const bad = await driver.gesture([]);
		expect(!bad.success && bad.error.code).toBe("E_BAD_REQUEST");
	});

	test("maxPointers follows the sdk: 1 from 26, 0 below and when unknown; below 26 a gesture is E_UNSUPPORTED", async () => {
		const old = await setup({ shell: [{ match: "getprop sys.boot_completed", reply: probe(24) }] });
		expect(old.driver.capabilities.maxPointers).toBe(0);
		const res = await old.driver.gesture([
			{
				points: [
					{ x: 1, y: 1 },
					{ x: 5, y: 5 },
				],
			},
		]);
		expect(!res.success && res.error.code).toBe("E_UNSUPPORTED");
		const unknown = await setup({ shell: [{ match: "getprop sys.boot_completed", reply: probe(undefined) }] });
		expect(unknown.driver.capabilities.maxPointers).toBe(0);
	});

	test("clipboard is E_UNSUPPORTED", async () => {
		const { driver } = await setup();
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

	test("network goes through the emulator console and dumpsys", async () => {
		const { driver, host } = await setup({
			shell: [{ match: "dumpsys connectivity", reply: DUMPSYS_ONLINE }],
			host: [{ match: /emu network/, reply: "OK\n" }],
		});
		const state = await value(driver.network({ kind: "preset", preset: "edge" }));
		expect(state).toEqual({ online: true, condition: { kind: "preset", preset: "edge" }, needsProxy: [] });
		expect(host.host).toEqual([
			["adb", "-s", "emulator-5554", "emu", "network", "speed", "200:240"],
			["adb", "-s", "emulator-5554", "emu", "network", "delay", "175:225"],
		]);
		expect(host.shell).toContain("cmd connectivity airplane-mode disable");
	});

	test("biometrics: match and fail touch the emulator sensor over the console; status parses dumpsys", async () => {
		const { driver, host } = await setup({
			shell: [{ match: "dumpsys fingerprint", reply: '{"prints":[{"id":0,"count":1}]}' }],
		});
		expect(await value(driver.biometrics("match"))).toEqual({ enrolled: true, modality: "fingerprint" });
		expect(await value(driver.biometrics("fail"))).toEqual({ enrolled: true, modality: "fingerprint" });
		expect(host.host).toContainEqual(["adb", "-s", "emulator-5554", "emu", "finger", "touch", "1"]);
		expect(host.host).toContainEqual(["adb", "-s", "emulator-5554", "emu", "finger", "touch", "99"]);
		const status = await value(driver.biometrics("status"));
		expect(status.enrolled).toBe(true);
	});

	test("biometrics: unenrolled status; a failing console is E_IO", async () => {
		const { driver } = await setup({
			shell: [{ match: "dumpsys fingerprint", reply: '{"prints":[{"id":0,"count":0}]}' }],
			host: [{ match: "adb -s emulator-5554 emu finger", reply: { exitCode: 1, stdout: "KO: no fingerprint hw" } }],
		});
		expect((await value(driver.biometrics("status"))).enrolled).toBe(false);
		const res = await driver.biometrics("match");
		expect(!res.success && res.error.code).toBe("E_IO");
	});

	test("biometrics: a physical device is E_UNSUPPORTED and nothing is sent", async () => {
		const { driver, host } = await setup({ serial: "R58M123ABC" });
		const res = await driver.biometrics("match");
		expect(!res.success && res.error.code).toBe("E_UNSUPPORTED");
		expect(host.host.some((argv) => argv.includes("emu"))).toBe(false);
	});

	test("biometrics: enroll and unenroll point at the golden snapshot", async () => {
		const { driver } = await setup();
		for (const op of ["enroll", "unenroll"] as const) {
			const res = await driver.biometrics(op);
			expect(!res.success && res.error.code).toBe("E_UNSUPPORTED");
			expect(!res.success && res.error.message).toContain("golden");
		}
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
	const dumps = (host: FakeAndroidHost): number =>
		host.shell.filter((c) => c.includes("uiautomator dump")).length +
		host.host.filter((a) => a.includes("uiautomator")).length;

	test("settle is one dump: uiautomator already waits for a second of idle before it reads", async () => {
		const { driver, host } = await setup({ dumpRoute: "stdout" });
		const before = dumps(host);
		const out = await value(driver.settle({ quietMs: 250, timeoutMs: 3000 }));
		expect(dumps(host) - before).toBe(1);
		expect(out.quiet).toBe(true);
	});

	test("the default settle is one dump too, and reports how long it took", async () => {
		const { driver, host, clock } = await setup({
			dumpRoute: "stdout",
			shell: [
				{
					match: "uiautomator dump /dev/stdout",
					reply: () => {
						clock.advance(1_900);
						return SYNTHETIC_FORM_DUMP;
					},
				},
			],
		});
		const before = dumps(host);
		const out = await value(driver.settle());
		expect(dumps(host) - before).toBe(1);
		expect(settleDetailOf(out)).toEqual({ quiet: true, waitedMs: 1_900, via: "snapshot" });
	});

	test("a dump that waited out uiautomator's 10 s idle limit saw a screen that never went quiet", async () => {
		const { driver, clock } = await setup({
			dumpRoute: "stdout",
			shell: [
				{
					match: "uiautomator dump /dev/stdout",
					reply: () => {
						clock.advance(10_400);
						return SYNTHETIC_FORM_DUMP;
					},
				},
			],
		});
		expect(settleDetailOf(await value(driver.settle()))).toEqual({ quiet: false, waitedMs: 10_400, via: "snapshot" });
	});

	test("a settle whose dump fails is not quiet", async () => {
		const bad = "ERROR: null root node returned by UiTestAutomationBridge.\n";
		const { driver } = await setup({
			shell: [{ match: "uiautomator", reply: bad }],
			host: [{ match: "adb", reply: bad }],
		});
		const out = await value(driver.settle({ quietMs: 250, timeoutMs: 3000 }));
		expect(out.quiet).toBe(false);
	});

	test("a quiet window longer than the dump's own idle wait still compares successive dumps", async () => {
		const { driver, host } = await setup({ dumpRoute: "stdout" });
		const before = dumps(host);
		const out = await value(driver.settle({ quietMs: 1_500, timeoutMs: 4_000 }));
		expect(dumps(host) - before).toBeGreaterThan(2);
		expect(out.quiet).toBe(true);
		expect(out.waitedMs).toBeGreaterThanOrEqual(1_500);
		expect(settleDetailOf(out).via).toBe("hash");
	});

	test("that comparison gives up when the UI keeps changing", async () => {
		let n = 0;
		const { driver } = await setup({
			shell: [
				{
					match: "uiautomator dump /dev/stdout",
					reply: () => SYNTHETIC_FORM_DUMP.replace("Sign in", `Sign in ${++n}`),
				},
			],
		});
		const out = await value(driver.settle({ quietMs: 1_500, timeoutMs: 2_000 }));
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

	test("alertIn reads the alert out of a snapshot already taken, without touching the device", async () => {
		const dialog =
			'<?xml version="1.0"?><hierarchy rotation="0"><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" enabled="true" clickable="false">' +
			'<node class="android.widget.Button" resource-id="android:id/button1" text="OK" bounds="[0,0][100,100]" enabled="true" clickable="true" />' +
			"</node></hierarchy>";
		const { driver, host } = await setup({ shell: [{ match: "uiautomator dump /dev/stdout", reply: dialog }] });
		expect(canDetectAlerts(driver)).toBe(true);
		if (!canDetectAlerts(driver)) return;
		const snapshot = await value(driver.snapshot());
		const dumps = host.shell.filter((c) => c.includes("uiautomator dump")).length;
		expect(driver.alertIn(snapshot)?.buttons.map((b) => b.text)).toEqual(["OK"]);
		expect(host.shell.filter((c) => c.includes("uiautomator dump")).length).toBe(dumps);
	});

	test("alertIn is null on a screen without an alert", async () => {
		const { driver } = await setup();
		if (!canDetectAlerts(driver)) throw new Error("no alertIn");
		expect(driver.alertIn(await value(driver.snapshot()))).toBeNull();
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

	test("openUrl targets the app under test with -p", async () => {
		const { driver, host } = await setup({ appPackage: "nz.co.x" });
		await value(driver.app.openUrl("myapp://todo/1"));
		expect(host.shell).toContain("am start -a android.intent.action.VIEW -d myapp://todo/1 -p nz.co.x");
	});

	test("openUrl without a known app package leaves the intent open to any handler", async () => {
		const { driver, host } = await setup();
		await value(driver.app.openUrl("myapp://todo/1"));
		expect(host.shell).toContain("am start -a android.intent.action.VIEW -d myapp://todo/1");
	});

	test("close shuts the shell and is idempotent", async () => {
		const { driver } = await setup();
		await driver.close();
		await driver.close();
		const res = await driver.tap({ x: 1, y: 1 });
		expect(res.success).toBe(false);
	});
});

const XML_TRAILER = "UI hierchary dumped to: /dev/stdout\n";
const NULL_ROOT = "ERROR: null root node returned by UiTestAutomationBridge.\n";
const ONLY_FILE_ROUTE: { shell: ShellRule[]; host: HostRule[] } = {
	shell: [
		{ match: "uiautomator dump /dev/stdout", reply: XML_TRAILER },
		{ match: /^rm -f \/sdcard\/warden-ui\.xml/, reply: SYNTHETIC_FORM_DUMP },
	],
	host: [{ match: /exec-out uiautomator dump \/dev\/tty$/, reply: NULL_ROOT }],
};
const routeProbes = (host: FakeAndroidHost): number =>
	host.host.filter((a) => a.includes("exec-out") && a.includes("uiautomator")).length +
	host.shell.filter((c) => c.includes("uiautomator dump") || c.startsWith("rm -f /sdcard/warden-ui.xml")).length;

describe("remembered dump route", () => {
	test("a route found in one driver is not probed for again by the next, per serial", async () => {
		const state = memoryAndroidState();
		const first = await setup({ ...ONLY_FILE_ROUTE, state });
		await value(first.driver.snapshot());
		expect(routeProbes(first.host)).toBe(3);
		await first.driver.close();
		expect(await state.read("emulator-5554")).toEqual({ sdk: 34, dumpRoute: "file" });

		const second = await setup({ ...ONLY_FILE_ROUTE, state });
		await value(second.driver.snapshot());
		await value(second.driver.snapshot());
		expect(routeProbes(second.host)).toBe(2);
		expect(second.host.host.filter((a) => a.includes("exec-out")).length).toBe(0);
		expect(second.host.shell.filter((c) => c.includes("/dev/stdout")).length).toBe(0);
	});

	test("another serial has its own route", async () => {
		const state = memoryAndroidState();
		await state.update("emulator-9999", (s) => ({ ...s, sdk: 34, dumpRoute: "file" }));
		const { driver, host } = await setup({ ...ONLY_FILE_ROUTE, state });
		await value(driver.snapshot());
		expect(routeProbes(host)).toBe(3);
	});

	test("a remembered route that no longer works is re-probed and the working one is saved", async () => {
		const state = memoryAndroidState();
		await state.update("emulator-5554", (s) => ({ ...s, sdk: 34, dumpRoute: "tty" }));
		const { driver, host } = await setup({
			state,
			shell: [{ match: "uiautomator dump /dev/stdout", reply: SYNTHETIC_FORM_DUMP }],
			host: [{ match: /exec-out uiautomator dump \/dev\/tty$/, reply: XML_TRAILER }],
		});
		await value(driver.snapshot());
		expect(host.host.filter((a) => a.includes("exec-out")).length).toBe(1);
		await driver.close();
		expect(await state.read("emulator-5554")).toEqual({ sdk: 34, dumpRoute: "stdout" });
	});

	test("a different API level means a different image: the old route is not trusted", async () => {
		const state = memoryAndroidState();
		await state.update("emulator-5554", (s) => ({ ...s, sdk: 28, dumpRoute: "file" }));
		const { driver, host } = await setup({ ...ONLY_FILE_ROUTE, state });
		await value(driver.snapshot());
		expect(routeProbes(host)).toBe(3);
		await driver.close();
		expect(await state.read("emulator-5554")).toEqual({ sdk: 34, dumpRoute: "file" });
	});

	test("a route the caller passes wins over the saved one and is still reported when it changes", async () => {
		const state = memoryAndroidState();
		await state.update("emulator-5554", (s) => ({ ...s, sdk: 34, dumpRoute: "file" }));
		const routes: string[] = [];
		const { driver, host } = await setup({
			state,
			dumpRoute: "stdout",
			onDumpRoute: (r) => routes.push(r),
			shell: [{ match: "uiautomator dump /dev/stdout", reply: XML_TRAILER }],
			host: [{ match: /exec-out uiautomator dump \/dev\/tty$/, reply: SYNTHETIC_FORM_DUMP }],
		});
		await value(driver.snapshot());
		expect(host.shell.filter((c) => c.includes("/dev/stdout")).length).toBe(1);
		expect(routes).toEqual(["tty"]);
	});

	test("with no store nothing is saved and the driver still works", async () => {
		const { driver } = await setup(ONLY_FILE_ROUTE);
		const snap = await value(driver.snapshot());
		expect(snap.flat.length).toBeGreaterThan(10);
	});
});

/** A fake `settings` store behind the shell: `get`, `put` and `delete` on the `global` table, `; `-separated. */
function settingsRule(values: Map<string, string>): ShellRule {
	return {
		match: /^settings (get|put|delete) global /,
		reply: (command) => {
			let out = "";
			for (const part of command.split("; ")) {
				const get = /^settings get global (\w+)$/.exec(part);
				if (get?.[1]) out += `${values.get(get[1]) ?? "null"}\n`;
				const put = /^settings put global (\w+) (\S+)$/.exec(part);
				if (put?.[1] && put[2] !== undefined) values.set(put[1], put[2]);
				const del = /^settings delete global (\w+)$/.exec(part);
				if (del?.[1]) values.delete(del[1]);
			}
			return out;
		},
	};
}

const SCALES = ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"] as const;
const scalesAt = (value: string): Map<string, string> => new Map(SCALES.map((k) => [k, value]));
const ONES = {
	window_animation_scale: "1.0",
	transition_animation_scale: "1.0",
	animator_duration_scale: "1.0",
};

describe("animation scales", () => {
	test("opening turns them off, closing puts the recorded values back", async () => {
		const values = scalesAt("1.0");
		const state = memoryAndroidState();
		const { driver, host } = await setup({ shell: [settingsRule(values)], state });
		expect([...values.entries()]).toEqual([
			["window_animation_scale", "0"],
			["transition_animation_scale", "1.0"],
			["animator_duration_scale", "0"],
		]);
		expect((await state.read("emulator-5554")).animations).toEqual(ONES);

		await driver.close();
		expect([...values.entries()]).toEqual(SCALES.map((k) => [k, "1.0"]));
		expect(host.shell.at(-1)).toBe(
			"settings put global window_animation_scale 1.0; settings put global transition_animation_scale 1.0; settings put global animator_duration_scale 1.0"
		);
		expect((await state.read("emulator-5554")).animations).toBeUndefined();
	});

	test("reduce motion is off by default: the transition scale RN reads is the device's own, window and animator stay 0", async () => {
		const values = scalesAt("1.0");
		values.set("transition_animation_scale", "0.5");
		const { driver } = await setup({ shell: [settingsRule(values)], state: memoryAndroidState() });
		expect(values.get("transition_animation_scale")).toBe("0.5");
		expect(values.get("window_animation_scale")).toBe("0");
		expect(values.get("animator_duration_scale")).toBe("0");
		await driver.close();
		expect(values.get("transition_animation_scale")).toBe("0.5");
	});

	test("reduceMotion: true zeroes the transition scale, false and close bring the original back", async () => {
		const values = scalesAt("1.0");
		const { driver } = await setup({ shell: [settingsRule(values)], state: memoryAndroidState() });
		const on = await driver.a11y({ reduceMotion: true });
		expect(on.success && on.data.applied).toEqual(["reduceMotion"]);
		expect(values.get("transition_animation_scale")).toBe("0");
		await driver.a11y({ reduceMotion: false });
		expect(values.get("transition_animation_scale")).toBe("1.0");
		await driver.a11y({ reduceMotion: true });
		await driver.close();
		expect(values.get("transition_animation_scale")).toBe("1.0");
	});

	test("a scale that was never set is deleted again, not set to a guess", async () => {
		const values = new Map<string, string>([["window_animation_scale", "0.5"]]);
		const { driver } = await setup({ shell: [settingsRule(values)], state: memoryAndroidState() });
		expect(values.has("transition_animation_scale")).toBe(false);
		expect(values.get("animator_duration_scale")).toBe("0");
		await driver.close();
		expect([...values.entries()]).toEqual([["window_animation_scale", "0.5"]]);
	});

	test("scales that were already off are left alone and nothing is saved", async () => {
		const values = scalesAt("0");
		const state = memoryAndroidState();
		const { driver, host } = await setup({ shell: [settingsRule(values)], state });
		await driver.close();
		expect(host.shell.filter((c) => c.startsWith("settings")).length).toBe(1);
		expect(await state.read("emulator-5554")).toEqual({});
	});

	test("without a store they are still restored when the driver closes", async () => {
		const values = scalesAt("1.0");
		const { driver } = await setup({ shell: [settingsRule(values)] });
		expect([...values.values()]).toEqual(["0", "1.0", "0"]);
		await driver.close();
		expect([...values.values()]).toEqual(["1.0", "1.0", "1.0"]);
	});

	test("a crash that never closed the driver leaves the originals in the file for the next open to restore", async () => {
		const values = scalesAt("1.0");
		const state = memoryAndroidState();
		const crashed = fakeAndroidHost({ shell: [settingsRule(values), ...BASE_RULES] });
		const opened = await openAndroidDriver({
			serial: "emulator-5554",
			adb: "adb",
			exec: crashed.exec,
			spawn: crashed.spawn,
			clock: fakeClock(),
			state,
		});
		expect(opened.success).toBe(true);
		expect([...values.values()]).toEqual(["0", "1.0", "0"]);

		const next = await setup({ shell: [settingsRule(values)], state });
		expect([...values.values()]).toEqual(["0", "1.0", "0"]);
		expect((await state.read("emulator-5554")).animations).toEqual(ONES);
		await next.driver.close();
		expect([...values.values()]).toEqual(["1.0", "1.0", "1.0"]);
		expect((await state.read("emulator-5554")).animations).toBeUndefined();
	});

	test("a restore that fails keeps the originals in the file", async () => {
		const values = scalesAt("1.0");
		const state = memoryAndroidState();
		const { driver, lines } = await setup({
			shell: [
				{ match: /^settings put global window_animation_scale 1\.0/, reply: { stdout: "Error\n", exitCode: 1 } },
				settingsRule(values),
			],
			state,
		});
		await driver.close();
		expect(lines.some((l) => l.includes("could not restore"))).toBe(true);
		expect((await state.read("emulator-5554")).animations).toEqual(ONES);
	});

	test("scales that cannot be read are neither recorded nor 'restored'", async () => {
		const state = memoryAndroidState();
		const { driver, host } = await setup({ state });
		await driver.close();
		expect(host.shell.filter((c) => c.startsWith("settings")).length).toBe(1);
		expect((await state.read("emulator-5554")).animations).toBeUndefined();
	});

	test("closing twice restores once", async () => {
		const values = scalesAt("1.0");
		const { driver, host } = await setup({ shell: [settingsRule(values)] });
		await driver.close();
		await driver.close();
		expect(host.shell.filter((c) => c.startsWith("settings put global window_animation_scale 1.0")).length).toBe(1);
	});
});

describe("physical phone safety (PHY-2.4)", () => {
	const PHONE = "R5CT1234ABC";
	const phoneProbe = (tail: string): string => `${probe(34)}${tail}`;
	const AWAKE = "wdn_qemu:\nmWakefulness=Awake\n  showing=false\n  secure=true\n";
	const phoneRules = (tail: string = AWAKE): ShellRule[] => [
		{ match: "getprop sys.boot_completed", reply: phoneProbe(tail) },
	];
	const settingsReads: ShellRule[] = [
		{ match: "settings get system accelerometer_rotation", reply: "1\n" },
		{ match: "settings get system user_rotation", reply: "0\n" },
		{ match: "cmd uimode night", reply: "Night mode: no\n" },
	];

	test("an emulator serial is probed exactly as before, with no phone steps", async () => {
		const { host } = await setup();
		expect(host.shell[0]).toBe("getprop sys.boot_completed; getprop ro.build.version.sdk; wm size; wm density");
		expect(host.shell.some((c) => c.includes("keyevent") || c.includes("dismiss-keyguard"))).toBe(false);
	});

	test("an awake, unlocked phone opens with the extended probe and no wake or settings writes besides animations", async () => {
		const { host } = await setup({ serial: PHONE, shell: phoneRules() });
		expect(host.shell[0]).toContain("ro.boot.qemu");
		expect(host.shell.some((c) => c.includes("keyevent 224") || c.includes("settings put system"))).toBe(false);
	});

	test("a sleeping phone is woken before anything else is written", async () => {
		const asleep = "wdn_qemu:\nmWakefulness=Asleep\n  showing=false\n  secure=true\n";
		const { host } = await setup({
			serial: PHONE,
			shell: [{ match: "dumpsys window policy", reply: "  showing=false\n  secure=true\n" }, ...phoneRules(asleep)],
		});
		expect(host.shell[1]).toBe("input keyevent 224");
		expect(host.shell.findIndex((c) => c.includes("settings put global"))).toBeGreaterThan(1);
	});

	test("a phone behind a secure keyguard fails the open with E_DEVICE_LOCKED and changes nothing", async () => {
		const host = fakeAndroidHost({
			shell: phoneRules("wdn_qemu:\nmWakefulness=Awake\n  showing=true\n  secure=true\n"),
		});
		const opened = await openAndroidDriver({
			serial: PHONE,
			adb: "adb",
			exec: host.exec,
			spawn: host.spawn,
			clock: fakeClock(),
		});
		expect(!opened.success && opened.error.code).toBe("E_DEVICE_LOCKED");
		expect(host.shell.some((c) => c.includes("settings put"))).toBe(false);
	});

	test("rotation and dark mode are saved before the first write and restored on close", async () => {
		const state = memoryAndroidState();
		const { driver, host } = await setup({ serial: PHONE, state, shell: [...settingsReads, ...phoneRules()] });
		await value(driver.orientation("landscapeLeft"));
		expect(await state.read(PHONE)).toMatchObject({ rotation: { accelerometer_rotation: "1", user_rotation: "0" } });
		await value(driver.appearance("dark"));
		const rotateAt = host.shell.indexOf("settings put system accelerometer_rotation 0");
		expect(host.shell.indexOf("settings get system accelerometer_rotation")).toBeLessThan(rotateAt);
		await driver.close();
		expect(host.shell.slice(-3)).toEqual([
			"settings put system accelerometer_rotation 1",
			"settings put system user_rotation 0",
			"cmd uimode night no",
		]);
		expect((await state.read(PHONE)).rotation).toBeUndefined();
	});

	test("an emulator rotates without saving anything", async () => {
		const { driver, host } = await setup();
		await value(driver.orientation("landscapeLeft"));
		expect(host.shell.some((c) => c.startsWith("settings get system"))).toBe(false);
	});

	test("uninstall and clearData of a package warden did not install are E_REFUSED on a phone", async () => {
		const { driver, host } = await setup({ serial: PHONE, appPackage: "com.example.app", shell: phoneRules() });
		for (const act of [() => driver.app.uninstall("com.bank.app"), () => driver.app.clearData("com.bank.app")]) {
			const res = await act();
			expect(!res.success && res.error.code).toBe("E_REFUSED");
			expect(!res.success && res.error.message).toContain("physical_protected");
		}
		expect(host.host.some((a) => a.includes("uninstall"))).toBe(false);
		expect(host.shell.some((c) => c.startsWith("pm clear"))).toBe(false);
	});

	test("the app under test and installs warden recorded may be uninstalled or cleared on a phone", async () => {
		const { driver } = await setup({
			serial: PHONE,
			appPackage: "com.example.app",
			ownedPackages: ["com.example.other"],
			shell: [{ match: "pm clear", reply: "Success\n" }, ...phoneRules()],
		});
		expect((await driver.app.clearData("com.example.app")).success).toBe(true);
		expect((await driver.app.clearData("com.example.other")).success).toBe(true);
	});

	test("an emulator may uninstall anything, as before", async () => {
		const { driver } = await setup({
			appPackage: "com.example.app",
			shell: [{ match: "pm clear", reply: "Success\n" }],
		});
		expect((await driver.app.clearData("com.other")).success).toBe(true);
	});
});
