import { describe, expect, test } from "bun:test";
import { captureWith, type ScreenshotRun, screenshotArgv } from "./screenshot";

describe("screenshotArgv", () => {
	test("iOS: simctl io screenshot straight to the file", () => {
		expect(screenshotArgv("ios", "U1", "/l/a.png", {})).toEqual([
			"xcrun",
			"simctl",
			"io",
			"U1",
			"screenshot",
			"/l/a.png",
		]);
	});

	test("Android: adb exec-out screencap (png on stdout), adb from ANDROID_HOME", () => {
		expect(screenshotArgv("android", "emulator-5554", "/l/a.png", {})).toEqual([
			"adb",
			"-s",
			"emulator-5554",
			"exec-out",
			"screencap",
			"-p",
		]);
		expect(screenshotArgv("android", "emulator-5554", "/l/a.png", { ANDROID_HOME: "/sdk" })[0]).toBe(
			"/sdk/platform-tools/adb"
		);
	});
});

describe("captureWith", () => {
	const png = new Uint8Array([137, 80, 78, 71]);

	function fake(result: Awaited<ReturnType<ScreenshotRun>> | Error) {
		const ran: string[][] = [];
		const written = new Map<string, Uint8Array>();
		const run: ScreenshotRun = async (argv) => {
			ran.push(argv);
			if (result instanceof Error) throw result;
			return result;
		};
		return { ran, written, run, write: async (path: string, data: Uint8Array) => void written.set(path, data) };
	}

	test("iOS: true on exit 0, nothing written by us", async () => {
		const f = fake({ exitCode: 0, stdout: new Uint8Array() });
		expect(await captureWith(f, "ios", "U1", "/l/a.png", {})).toBe(true);
		expect(f.ran[0]?.slice(0, 5)).toEqual(["xcrun", "simctl", "io", "U1", "screenshot"]);
		expect(f.written.size).toBe(0);
	});

	test("Android: stdout bytes are written to the file", async () => {
		const f = fake({ exitCode: 0, stdout: png });
		expect(await captureWith(f, "android", "emulator-5554", "/l/a.png", {})).toBe(true);
		expect(f.written.get("/l/a.png")).toEqual(png);
	});

	test("best effort: non-zero exit, empty Android output or a throw is false, never an error", async () => {
		expect(await captureWith(fake({ exitCode: 1, stdout: png }), "ios", "U1", "/l/a.png", {})).toBe(false);
		expect(await captureWith(fake({ exitCode: 0, stdout: new Uint8Array() }), "android", "e", "/l/a.png", {})).toBe(
			false
		);
		expect(await captureWith(fake(new Error("spawn failed")), "ios", "U1", "/l/a.png", {})).toBe(false);
	});
});
