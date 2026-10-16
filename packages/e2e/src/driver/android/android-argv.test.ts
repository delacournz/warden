import { describe, expect, test } from "bun:test";
import {
	animationScaleArgvs,
	buttonKeycode,
	dragMotionCommand,
	dumpFileCommand,
	dumpStdoutArgv,
	dumpTtyHostArgv,
	forceStopArgv,
	getpropArgv,
	installArgv,
	keycombinationArgv,
	keyeventArgv,
	keyNameKeycode,
	keyRepeatArgvs,
	longPressArgv,
	modifierKeycode,
	monkeyLaunchArgv,
	motionEventArgv,
	pidofArgv,
	pmClearArgv,
	pmPathArgv,
	rotationArgvs,
	SELECT_ALL_MIN_SDK,
	screencapArgv,
	selectAllArgv,
	shellCommand,
	shellQuote,
	sleepArgv,
	startUrlArgv,
	swipeArgv,
	tapArgv,
	textArgvs,
	uimodeGetArgv,
	uimodeSetArgv,
	uninstallArgv,
	userRotationArgv,
} from "./android-argv";

describe("shellQuote / shellCommand", () => {
	test("leaves safe words bare and single-quotes the rest", () => {
		expect(shellQuote("input")).toBe("input");
		expect(shellQuote("a/b.c-d_e:1=2,3@4%5+6")).toBe("a/b.c-d_e:1=2,3@4%5+6");
		expect(shellQuote("hello world")).toBe("'hello world'");
		expect(shellQuote("")).toBe("''");
		expect(shellQuote("it's")).toBe("'it'\\''s'");
		expect(shellQuote('a;b&c|d$e`f"g\\h')).toBe("'a;b&c|d$e`f\"g\\h'");
	});

	test("joins quoted args", () => {
		expect(shellCommand(["am", "start", "-d", "https://x.y/?a=1&b=2"])).toBe("am start -d 'https://x.y/?a=1&b=2'");
	});
});

describe("input argv", () => {
	test("tap rounds to integer pixels", () => {
		expect(tapArgv({ x: 100.4, y: 200.6 })).toEqual(["input", "tap", "100", "201"]);
	});

	test("swipe carries a duration, floored at 1 ms", () => {
		expect(swipeArgv({ x: 1, y: 2 }, { x: 3, y: 4 }, 250)).toEqual(["input", "swipe", "1", "2", "3", "4", "250"]);
		expect(swipeArgv({ x: 1, y: 2 }, { x: 3, y: 4 }, 0)).toEqual(["input", "swipe", "1", "2", "3", "4", "1"]);
		expect(swipeArgv({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual(["input", "swipe", "1", "2", "3", "4", "300"]);
	});

	test("long press is a swipe in place", () => {
		expect(longPressArgv({ x: 10, y: 20 }, 800)).toEqual(["input", "swipe", "10", "20", "10", "20", "800"]);
		expect(longPressArgv({ x: 10, y: 20 })).toEqual(["input", "swipe", "10", "20", "10", "20", "600"]);
	});

	test("keyevent", () => {
		expect(keyeventArgv(66)).toEqual(["input", "keyevent", "66"]);
	});

	test("key repeats are batched into one call per 32 presses", () => {
		expect(keyRepeatArgvs(67, 3)).toEqual([["input", "keyevent", "67", "67", "67"]]);
		expect(keyRepeatArgvs(67, 0)).toEqual([]);
		const chunks = keyRepeatArgvs(67, 70);
		expect(chunks.map((c) => c.length - 2)).toEqual([32, 32, 6]);
	});

	test("select all is Ctrl+A through keycombination, which needs API 33", () => {
		expect(selectAllArgv()).toEqual(["input", "keycombination", "113", "29"]);
		expect(SELECT_ALL_MIN_SDK).toBe(33);
	});

	test("hardware button and key name keycodes", () => {
		expect(buttonKeycode("home")).toBe(3);
		expect(buttonKeycode("back")).toBe(4);
		expect(buttonKeycode("volumeUp")).toBe(24);
		expect(buttonKeycode("volumeDown")).toBe(25);
		expect(buttonKeycode("lock")).toBe(26);
		expect(buttonKeycode("shake")).toBeUndefined();
		expect(keyNameKeycode("Enter")).toBe(66);
		expect(keyNameKeycode("Backspace")).toBe(67);
		expect(keyNameKeycode("Tab")).toBe(61);
		expect(keyNameKeycode("Space")).toBe(62);
		expect(keyNameKeycode("Escape")).toBe(111);
		expect(keyNameKeycode("Delete")).toBe(112);
		expect(keyNameKeycode("Up")).toBe(19);
		expect(keyNameKeycode("Down")).toBe(20);
		expect(keyNameKeycode("Left")).toBe(21);
		expect(keyNameKeycode("Right")).toBe(22);
	});
});

describe("textArgvs", () => {
	const argvs = (text: string): string[][] => {
		const result = textArgvs(text);
		if (!result.success) throw new Error(result.error.message);
		return result.data;
	};

	test("spaces become %s", () => {
		expect(argvs("hello big world")).toEqual([["input", "text", "hello%sbig%sworld"]]);
	});

	test("shell metacharacters survive quoting", () => {
		const [first] = argvs('it\'s $HOME & `x` "y"');
		expect(first && shellCommand(first)).toBe("input text 'it'\\''s%s$HOME%s&%s`x`%s\"y\"'");
	});

	test("non-ASCII is E_UNSUPPORTED_TEXT", () => {
		for (const text of ["café", "日本", "😀", "tab\there", "new\nline"]) {
			const result = textArgvs(text);
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
		expect(startUrlArgv("myapp://home?x=1&y=2")).toEqual([
			"am",
			"start",
			"-a",
			"android.intent.action.VIEW",
			"-d",
			"myapp://home?x=1&y=2",
		]);
	});

	test("launch, force-stop, clear", () => {
		expect(monkeyLaunchArgv("com.x")).toEqual(["monkey", "-p", "com.x", "-c", "android.intent.category.LAUNCHER", "1"]);
		expect(forceStopArgv("com.x")).toEqual(["am", "force-stop", "com.x"]);
		expect(pmClearArgv("com.x")).toEqual(["pm", "clear", "com.x"]);
	});

	test("animations off covers all three scales", () => {
		expect(animationScaleArgvs()).toEqual([
			["settings", "put", "global", "window_animation_scale", "0"],
			["settings", "put", "global", "transition_animation_scale", "0"],
			["settings", "put", "global", "animator_duration_scale", "0"],
		]);
	});
});

describe("host argv", () => {
	test("screencap goes through exec-out, never the shell session", () => {
		expect(screencapArgv("/sdk/adb", "emulator-5554")).toEqual([
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
		expect(dumpStdoutArgv()).toEqual(["uiautomator", "dump", "/dev/stdout"]);
		expect(dumpTtyHostArgv("adb", "s1")).toEqual(["adb", "-s", "s1", "exec-out", "uiautomator", "dump", "/dev/tty"]);
		expect(dumpFileCommand()).toBe(
			'rm -f /sdcard/warden-ui.xml; OUT=$(uiautomator dump /sdcard/warden-ui.xml 2>&1); cat /sdcard/warden-ui.xml 2>/dev/null || echo "$OUT"'
		);
	});

	test("install/uninstall are host argv", () => {
		expect(installArgv("adb", "s1", "/a b/app.apk")).toEqual(["adb", "-s", "s1", "install", "-r", "/a b/app.apk"]);
		expect(uninstallArgv("adb", "s1", "com.x")).toEqual(["adb", "-s", "s1", "uninstall", "com.x"]);
	});

	test("queries and settings", () => {
		expect(getpropArgv("sys.boot_completed")).toEqual(["getprop", "sys.boot_completed"]);
		expect(pmPathArgv("com.x")).toEqual(["pm", "path", "com.x"]);
		expect(pidofArgv("com.x")).toEqual(["pidof", "com.x"]);
		expect(rotationArgvs(1)).toEqual([
			["settings", "put", "system", "accelerometer_rotation", "0"],
			["settings", "put", "system", "user_rotation", "1"],
		]);
		expect(userRotationArgv()).toEqual(["settings", "get", "system", "user_rotation"]);
		expect(uimodeGetArgv()).toEqual(["cmd", "uimode", "night"]);
		expect(uimodeSetArgv(true)).toEqual(["cmd", "uimode", "night", "yes"]);
		expect(uimodeSetArgv(false)).toEqual(["cmd", "uimode", "night", "no"]);
		expect(keycombinationArgv([113, 29])).toEqual(["input", "keycombination", "113", "29"]);
		expect(modifierKeycode("shift")).toBe(59);
		expect(modifierKeycode("ctrl")).toBe(113);
	});
});

describe("hold-then-move drag", () => {
	test("motion events and sleeps", () => {
		expect(motionEventArgv("DOWN", { x: 1.4, y: 2.6 })).toEqual(["input", "motionevent", "DOWN", "1", "3"]);
		expect(sleepArgv(1250)).toEqual(["sleep", "1.250"]);
		expect(sleepArgv(-5)).toEqual(["sleep", "0.000"]);
	});

	test("one step line, CANCEL on failure", () => {
		expect(
			dragMotionCommand({ x: 0, y: 0 }, { x: 10, y: 20 }, { pressMs: 100, durationMs: 200, releaseMs: 0, steps: 1 })
		).toBe(
			"input motionevent DOWN 0 0 && sleep 0.100 && input motionevent MOVE 10 20 && sleep 0.200 && sleep 0.000 && input motionevent UP 10 20 || (input motionevent CANCEL 10 20; exit 1)"
		);
	});
});
