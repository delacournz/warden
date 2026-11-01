import { describe, expect, test } from "bun:test";
import { androidArgv, SELECT_ALL_MIN_SDK, UNENROLLED_FINGER_ID } from "./android-argv";

describe("shellQuote / shellCommand", () => {
	test("leaves safe words bare and single-quotes the rest", () => {
		expect(androidArgv.shellQuote("input")).toBe("input");
		expect(androidArgv.shellQuote("a/b.c-d_e:1=2,3@4%5+6")).toBe("a/b.c-d_e:1=2,3@4%5+6");
		expect(androidArgv.shellQuote("hello world")).toBe("'hello world'");
		expect(androidArgv.shellQuote("")).toBe("''");
		expect(androidArgv.shellQuote("it's")).toBe("'it'\\''s'");
		expect(androidArgv.shellQuote('a;b&c|d$e`f"g\\h')).toBe("'a;b&c|d$e`f\"g\\h'");
	});

	test("joins quoted args", () => {
		expect(androidArgv.shellCommand(["am", "start", "-d", "https://x.y/?a=1&b=2"])).toBe(
			"am start -d 'https://x.y/?a=1&b=2'"
		);
	});
});

describe("input argv", () => {
	test("tap rounds to integer pixels", () => {
		expect(androidArgv.tapArgv({ x: 100.4, y: 200.6 })).toEqual(["input", "tap", "100", "201"]);
	});

	test("swipe carries a duration, floored at 1 ms", () => {
		expect(androidArgv.swipeArgv({ x: 1, y: 2 }, { x: 3, y: 4 }, 250)).toEqual([
			"input",
			"swipe",
			"1",
			"2",
			"3",
			"4",
			"250",
		]);
		expect(androidArgv.swipeArgv({ x: 1, y: 2 }, { x: 3, y: 4 }, 0)).toEqual([
			"input",
			"swipe",
			"1",
			"2",
			"3",
			"4",
			"1",
		]);
		expect(androidArgv.swipeArgv({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual([
			"input",
			"swipe",
			"1",
			"2",
			"3",
			"4",
			"300",
		]);
	});

	test("long press is a swipe in place", () => {
		expect(androidArgv.longPressArgv({ x: 10, y: 20 }, 800)).toEqual(["input", "swipe", "10", "20", "10", "20", "800"]);
		expect(androidArgv.longPressArgv({ x: 10, y: 20 })).toEqual(["input", "swipe", "10", "20", "10", "20", "600"]);
	});

	test("keyevent", () => {
		expect(androidArgv.keyeventArgv(66)).toEqual(["input", "keyevent", "66"]);
	});

	test("key repeats are batched into one call per 32 presses", () => {
		expect(androidArgv.keyRepeatArgvs(67, 3)).toEqual([["input", "keyevent", "67", "67", "67"]]);
		expect(androidArgv.keyRepeatArgvs(67, 0)).toEqual([]);
		const chunks = androidArgv.keyRepeatArgvs(67, 70);
		expect(chunks.map((c) => c.length - 2)).toEqual([32, 32, 6]);
	});

	test("select all is Ctrl+A through keycombination, which needs API 33", () => {
		expect(androidArgv.selectAllArgv()).toEqual(["input", "keycombination", "113", "29"]);
		expect(SELECT_ALL_MIN_SDK).toBe(33);
	});

	test("hardware button and key name keycodes", () => {
		expect(androidArgv.buttonKeycode("home")).toBe(3);
		expect(androidArgv.buttonKeycode("back")).toBe(4);
		expect(androidArgv.buttonKeycode("volumeUp")).toBe(24);
		expect(androidArgv.buttonKeycode("volumeDown")).toBe(25);
		expect(androidArgv.buttonKeycode("lock")).toBe(26);
		expect(androidArgv.buttonKeycode("shake")).toBeUndefined();
		expect(androidArgv.keyNameKeycode("Enter")).toBe(66);
		expect(androidArgv.keyNameKeycode("Backspace")).toBe(67);
		expect(androidArgv.keyNameKeycode("Tab")).toBe(61);
		expect(androidArgv.keyNameKeycode("Space")).toBe(62);
		expect(androidArgv.keyNameKeycode("Escape")).toBe(111);
		expect(androidArgv.keyNameKeycode("Delete")).toBe(112);
		expect(androidArgv.keyNameKeycode("Up")).toBe(19);
		expect(androidArgv.keyNameKeycode("Down")).toBe(20);
		expect(androidArgv.keyNameKeycode("Left")).toBe(21);
		expect(androidArgv.keyNameKeycode("Right")).toBe(22);
	});
});

describe("textArgvs", () => {
	const argvs = (text: string): string[][] => {
		const result = androidArgv.textArgvs(text);
		if (!result.success) throw new Error(result.error.message);
		return result.data;
	};

	test("spaces become %s", () => {
		expect(argvs("hello big world")).toEqual([["input", "text", "hello%sbig%sworld"]]);
	});

	test("shell metacharacters survive quoting", () => {
		const [first] = argvs('it\'s $HOME & `x` "y"');
		expect(first && androidArgv.shellCommand(first)).toBe("input text 'it'\\''s%s$HOME%s&%s`x`%s\"y\"'");
	});

	test("non-ASCII is E_UNSUPPORTED_TEXT", () => {
		for (const text of ["café", "日本", "😀", "tab\there", "new\nline"]) {
			const result = androidArgv.textArgvs(text);
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.code).toBe("E_UNSUPPORTED_TEXT");
				expect(result.error.retryable).toBe(false);
			}
		}
	});

	test("a literal %s is typed by splitting between the % and the s", () => {
		expect(argvs("100%safe")).toEqual([
			["input", "text", "100%"],
			["input", "text", "safe"],
		]);
		expect(argvs("%s")).toEqual([
			["input", "text", "%"],
			["input", "text", "s"],
		]);
	});

	test("a % before a space splits so the space escape starts a fresh call", () => {
		expect(argvs("50% off")).toEqual([
			["input", "text", "50%"],
			["input", "text", "%soff"],
		]);
	});

	test("%% and a trailing %", () => {
		expect(argvs("a%%b")).toEqual([["input", "text", "a%%b"]]);
		expect(argvs("%%s")).toEqual([
			["input", "text", "%%"],
			["input", "text", "s"],
		]);
		expect(argvs("50%")).toEqual([["input", "text", "50%"]]);
	});

	test("empty text has no argv", () => {
		expect(argvs("")).toEqual([]);
	});
});

describe("app argv", () => {
	test("open url", () => {
		expect(androidArgv.startUrlArgv("myapp://home?x=1&y=2")).toEqual([
			"am",
			"start",
			"-a",
			"android.intent.action.VIEW",
			"-d",
			"myapp://home?x=1&y=2",
		]);
	});

	test("open url can target the app under test with -p", () => {
		expect(androidArgv.startUrlArgv("myapp://todo/1", "nz.co.x")).toEqual([
			"am",
			"start",
			"-a",
			"android.intent.action.VIEW",
			"-d",
			"myapp://todo/1",
			"-p",
			"nz.co.x",
		]);
		expect(androidArgv.startUrlArgv("myapp://todo/1", undefined)).toEqual(androidArgv.startUrlArgv("myapp://todo/1"));
	});

	test("launch, force-stop, clear", () => {
		expect(androidArgv.monkeyLaunchArgv("com.x")).toEqual([
			"monkey",
			"-p",
			"com.x",
			"-c",
			"android.intent.category.LAUNCHER",
			"1",
		]);
		expect(androidArgv.forceStopArgv("com.x")).toEqual(["am", "force-stop", "com.x"]);
		expect(androidArgv.pmClearArgv("com.x")).toEqual(["pm", "clear", "com.x"]);
	});

	test("launcher resolution and the waiting component start", () => {
		expect(androidArgv.resolveLauncherArgv("com.x")).toEqual([
			"cmd",
			"package",
			"resolve-activity",
			"--brief",
			"-c",
			"android.intent.category.LAUNCHER",
			"com.x",
		]);
		const main = ["-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER"];
		expect(androidArgv.startComponentArgv("com.x/.MainActivity", { stop: true })).toEqual([
			"am",
			"start",
			"-W",
			"-S",
			...main,
			"-n",
			"com.x/.MainActivity",
		]);
		// the launcher's own intent (MAIN + LAUNCHER) matches the task's root, so a running app is brought to the front
		expect(androidArgv.startComponentArgv("com.x/.MainActivity", { stop: false })).toEqual([
			"am",
			"start",
			"-W",
			...main,
			"-n",
			"com.x/.MainActivity",
		]);
		expect(androidArgv.shellCommand(androidArgv.startComponentArgv("com.x/com.x.Main$Alias", { stop: true }))).toBe(
			"am start -W -S -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n 'com.x/com.x.Main$Alias'"
		);
	});

	test("animations off covers all three scales", () => {
		expect(androidArgv.animationScaleArgvs()).toEqual([
			["settings", "put", "global", "window_animation_scale", "0"],
			["settings", "put", "global", "transition_animation_scale", "0"],
			["settings", "put", "global", "animator_duration_scale", "0"],
		]);
	});
});

describe("animation scale argv", () => {
	test("reading asks for all three scales in a fixed order", () => {
		expect(androidArgv.animationReadArgvs()).toEqual([
			["settings", "get", "global", "window_animation_scale"],
			["settings", "get", "global", "transition_animation_scale"],
			["settings", "get", "global", "animator_duration_scale"],
		]);
	});

	test("restoring puts a value back and deletes a setting that was unset", () => {
		expect(
			androidArgv.animationRestoreArgvs({
				window_animation_scale: "1.0",
				transition_animation_scale: "null",
				animator_duration_scale: "0.5",
			})
		).toEqual([
			["settings", "put", "global", "window_animation_scale", "1.0"],
			["settings", "delete", "global", "transition_animation_scale"],
			["settings", "put", "global", "animator_duration_scale", "0.5"],
		]);
	});
});

describe("host argv", () => {
	test("screencap goes through exec-out, never the shell session", () => {
		expect(androidArgv.screencapArgv("/sdk/adb", "emulator-5554")).toEqual([
			"/sdk/adb",
			"-s",
			"emulator-5554",
			"exec-out",
			"screencap",
			"-p",
		]);
	});
});

describe("device/app query argv", () => {
	test("dump routes", () => {
		expect(androidArgv.dumpStdoutArgv()).toEqual(["uiautomator", "dump", "/dev/stdout"]);
		expect(androidArgv.dumpTtyHostArgv("adb", "s1")).toEqual([
			"adb",
			"-s",
			"s1",
			"exec-out",
			"uiautomator",
			"dump",
			"/dev/tty",
		]);
		expect(androidArgv.dumpFileCommand()).toBe(
			'rm -f /sdcard/warden-ui.xml; OUT=$(uiautomator dump /sdcard/warden-ui.xml 2>&1); cat /sdcard/warden-ui.xml 2>/dev/null || echo "$OUT"'
		);
	});

	test("install/uninstall are host argv", () => {
		expect(androidArgv.installArgv("adb", "s1", "/a b/app.apk")).toEqual([
			"adb",
			"-s",
			"s1",
			"install",
			"-r",
			"/a b/app.apk",
		]);
		expect(androidArgv.uninstallArgv("adb", "s1", "com.x")).toEqual(["adb", "-s", "s1", "uninstall", "com.x"]);
	});

	test("geo fix puts LONGITUDE before latitude", () => {
		expect(androidArgv.geoFixArgv("adb", "emulator-5554", { lat: 37.3318, lon: -122.0312 })).toEqual([
			"adb",
			"-s",
			"emulator-5554",
			"emu",
			"geo",
			"fix",
			"-122.0312",
			"37.3318",
		]);
		expect(androidArgv.geoFixArgv("adb", "e", { lat: -36.85, lon: 174.76 }, 12.5).slice(-3)).toEqual([
			"174.76",
			"-36.85",
			"12.5",
		]);
	});

	test("geo fix failure reads the console KO that adb exits 0 on", () => {
		const base = { exitCode: 0, stdout: "OK\n", stderr: "" };
		expect(androidArgv.geoFixFailure(base)).toBeUndefined();
		expect(androidArgv.geoFixFailure({ ...base, stdout: "KO: bad arguments\n" })).toBe(
			"emulator console: KO bad arguments"
		);
		expect(androidArgv.geoFixFailure({ exitCode: 1, stdout: "", stderr: "error: device offline" })).toContain(
			"device offline"
		);
	});

	test("queries and settings", () => {
		expect(androidArgv.getpropArgv("sys.boot_completed")).toEqual(["getprop", "sys.boot_completed"]);
		expect(androidArgv.pmPathArgv("com.x")).toEqual(["pm", "path", "com.x"]);
		expect(androidArgv.pidofArgv("com.x")).toEqual(["pidof", "com.x"]);
		expect(androidArgv.rotationArgvs(1)).toEqual([
			["settings", "put", "system", "accelerometer_rotation", "0"],
			["settings", "put", "system", "user_rotation", "1"],
		]);
		expect(androidArgv.userRotationArgv()).toEqual(["settings", "get", "system", "user_rotation"]);
		expect(androidArgv.uimodeGetArgv()).toEqual(["cmd", "uimode", "night"]);
		expect(androidArgv.uimodeSetArgv(true)).toEqual(["cmd", "uimode", "night", "yes"]);
		expect(androidArgv.uimodeSetArgv(false)).toEqual(["cmd", "uimode", "night", "no"]);
		expect(androidArgv.keycombinationArgv([113, 29])).toEqual(["input", "keycombination", "113", "29"]);
		expect(androidArgv.modifierKeycode("shift")).toBe(59);
		expect(androidArgv.modifierKeycode("ctrl")).toBe(113);
	});
});

describe("hold-then-move drag", () => {
	test("motion events and sleeps", () => {
		expect(androidArgv.motionEventArgv("DOWN", { x: 1.4, y: 2.6 })).toEqual(["input", "motionevent", "DOWN", "1", "3"]);
		expect(androidArgv.sleepArgv(1250)).toEqual(["sleep", "1.250"]);
		expect(androidArgv.sleepArgv(-5)).toEqual(["sleep", "0.000"]);
	});

	test("one step line, CANCEL on failure", () => {
		expect(
			androidArgv.dragMotionCommand(
				{ x: 0, y: 0 },
				{ x: 10, y: 20 },
				{ pressMs: 100, durationMs: 200, releaseMs: 0, steps: 1 }
			)
		).toBe(
			"input motionevent DOWN 0 0 && sleep 0.100 && input motionevent MOVE 10 20 && sleep 0.200 && sleep 0.000 && input motionevent UP 10 20 || (input motionevent CANCEL 10 20; exit 1)"
		);
	});
});

describe("single-finger gesture line", () => {
	const plan = (n: number, holdMs = 0, releaseMs = 0) => ({
		paths: [Array.from({ length: n }, (_, i) => ({ x: i * 10, y: i }))],
		frameMs: 20,
		holdMs,
		releaseMs,
		totalMs: (n - 1) * 20 + holdMs + releaseMs,
	});
	const moves = (line: string): string[] => line.match(/motionevent MOVE \d+ \d+/g) ?? [];

	test("a short path sends every frame as a MOVE, then UP at the last", () => {
		const line = androidArgv.gestureMotionCommand(plan(3, 100, 50));
		expect(line).toBe(
			"input motionevent DOWN 0 0 && sleep 0.100 && sleep 0.020 && input motionevent MOVE 10 1 && sleep 0.020 && input motionevent MOVE 20 2 && sleep 0.050 && input motionevent UP 20 2 || (input motionevent CANCEL 20 2; exit 1)"
		);
	});

	test("a long path is downsampled to at most 12 evenly spaced MOVEs and keeps the last frame", () => {
		const line = androidArgv.gestureMotionCommand(plan(101));
		const found = moves(line);
		expect(found).toHaveLength(12);
		expect(found.at(-1)).toBe("motionevent MOVE 1000 100");
		const xs = found.map((m) => Number(m.split(" ")[2]) / 10);
		const gaps = xs.slice(1).map((x, i) => x - (xs[i] as number));
		expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
		expect(line).toContain("input motionevent UP 1000 100");
	});

	test("maxMoves is honoured, and the sleeps keep the total travel time", () => {
		const line = androidArgv.gestureMotionCommand(plan(101), 4);
		expect(moves(line)).toHaveLength(4);
		const sleeps = [...line.matchAll(/sleep (\d+\.\d+)/g)].map((m) => Number(m[1]));
		expect(sleeps.reduce((a, b) => a + b, 0)).toBeCloseTo(2, 2);
	});

	test("one frame is DOWN then UP", () => {
		expect(androidArgv.gestureMotionCommand(plan(1))).toBe(
			"input motionevent DOWN 0 0 && sleep 0.000 && sleep 0.000 && input motionevent UP 0 0 || (input motionevent CANCEL 0 0; exit 1)"
		);
	});
});

describe("fingerprint", () => {
	test("emu finger touch and dumpsys argv", () => {
		expect(androidArgv.emuFingerTouchArgv("adb", "emulator-5554", 1)).toEqual([
			"adb",
			"-s",
			"emulator-5554",
			"emu",
			"finger",
			"touch",
			"1",
		]);
		expect(UNENROLLED_FINGER_ID).toBe(99);
		expect(androidArgv.dumpsysFingerprintArgv()).toEqual(["dumpsys", "fingerprint"]);
	});

	test("only emulator serials", () => {
		expect(androidArgv.isEmulatorSerial("emulator-5554")).toBe(true);
		expect(androidArgv.isEmulatorSerial("R58M123ABC")).toBe(false);
		expect(androidArgv.isEmulatorSerial("192.168.1.5:5555")).toBe(false);
	});
});
