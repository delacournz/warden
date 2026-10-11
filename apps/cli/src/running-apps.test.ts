import { describe, expect, test } from "bun:test";
import { hasForegroundApp, parseLaunchdApps } from "./running-apps";
import { fakeExec } from "./testing";

const LAUNCHCTL = `PID\tStatus\tLabel
123\t0\tUIKitApplication:com.apple.springboard[0x1][rb-legacy]
456\t0\tUIKitApplication:com.acme.app[0xabcd][rb-legacy]
-\t0\tcom.apple.something
`;

describe("parseLaunchdApps", () => {
	test("extracts bundle ids of running UIKitApplication entries only", () => {
		expect(parseLaunchdApps(LAUNCHCTL)).toEqual(["com.apple.springboard", "com.acme.app"]);
	});

	test("entries without a pid (not running) are ignored", () => {
		expect(parseLaunchdApps("-\t0\tUIKitApplication:com.acme.app[0x1]")).toEqual([]);
	});
});

describe("hasForegroundApp", () => {
	test("non-Apple app running → true", async () => {
		const exec = fakeExec([["xcrun simctl spawn U1 launchctl list", { stdout: LAUNCHCTL }]]);
		expect(await hasForegroundApp(exec, "ios", "U1")).toBe(true);
	});

	test("only Apple apps → false", async () => {
		const exec = fakeExec([
			["xcrun simctl spawn U1 launchctl list", { stdout: "1\t0\tUIKitApplication:com.apple.springboard[0x1]" }],
		]);
		expect(await hasForegroundApp(exec, "ios", "U1")).toBe(false);
	});

	test("probe failure → false (never blocks gc)", async () => {
		expect(await hasForegroundApp(fakeExec([]), "ios", "U1")).toBe(false);
	});

	test("android → false (grace period only)", async () => {
		expect(await hasForegroundApp(fakeExec([]), "android", "emulator-5554")).toBe(false);
	});
});
