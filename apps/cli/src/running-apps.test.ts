import { describe, expect, test } from "bun:test";
import { runningApps } from "./running-apps";
import { cliTesting } from "./testing";

const LAUNCHCTL = `PID\tStatus\tLabel
123\t0\tUIKitApplication:com.apple.springboard[0x1][rb-legacy]
456\t0\tUIKitApplication:com.acme.app[0xabcd][rb-legacy]
-\t0\tcom.apple.something
`;

describe("parseLaunchdApps", () => {
	test("extracts bundle ids of running UIKitApplication entries only", () => {
		expect(runningApps.parseLaunchdApps(LAUNCHCTL)).toEqual(["com.apple.springboard", "com.acme.app"]);
	});

	test("entries without a pid (not running) are ignored", () => {
		expect(runningApps.parseLaunchdApps("-\t0\tUIKitApplication:com.acme.app[0x1]")).toEqual([]);
	});
});

describe("hasForegroundApp", () => {
	test("non-Apple app running → true", async () => {
		const exec = cliTesting.fakeExec([["xcrun simctl spawn U1 launchctl list", { stdout: LAUNCHCTL }]]);
		expect(await runningApps.hasForegroundApp(exec, "ios", "U1")).toBe(true);
	});

	test("only Apple apps → false", async () => {
		const exec = cliTesting.fakeExec([
			["xcrun simctl spawn U1 launchctl list", { stdout: "1\t0\tUIKitApplication:com.apple.springboard[0x1]" }],
		]);
		expect(await runningApps.hasForegroundApp(exec, "ios", "U1")).toBe(false);
	});

	test("probe failure → false (never blocks gc)", async () => {
		expect(await runningApps.hasForegroundApp(cliTesting.fakeExec([]), "ios", "U1")).toBe(false);
	});

	test("android → false (grace period only)", async () => {
		expect(await runningApps.hasForegroundApp(cliTesting.fakeExec([]), "android", "emulator-5554")).toBe(false);
	});
});
