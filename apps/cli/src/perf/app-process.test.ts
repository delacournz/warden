import { afterEach, describe, expect, test } from "bun:test";
import { fakeExec, type TestContext, testContext } from "../testing";
import { appPid, iosAppBundle } from "./app-process";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

type Handler = [string, { stdout: string; exitCode?: number }];

function setup(handlers: Handler[]): { c: TestContext; calls: string[][] } {
	const calls: string[][] = [];
	ctx = testContext([], { exec: fakeExec(handlers, calls) });
	return { c: ctx, calls };
}

const APP = "/Users/x/Library/Developer/CoreSimulator/Devices/U1/data/Containers/Bundle/Application/AB/Example.app";

describe("iosAppBundle", () => {
	test("app container + CFBundleExecutable", async () => {
		const { c, calls } = setup([
			["xcrun simctl get_app_container U1 com.acme.shop app", { stdout: `${APP}\n` }],
			["plutil -extract CFBundleExecutable raw", { stdout: "Example\n" }],
		]);
		const r = await iosAppBundle(c, "U1", "com.acme.shop");
		expect(r).toEqual({
			success: true,
			data: { appPath: APP, executable: "Example", executablePath: `${APP}/Example` },
		});
		expect(calls[1]).toEqual(["plutil", "-extract", "CFBundleExecutable", "raw", "-o", "-", `${APP}/Info.plist`]);
	});

	test("not installed: app_not_found", async () => {
		const { c } = setup([["xcrun simctl get_app_container", { stdout: "", exitCode: 2 }]]);
		const r = await iosAppBundle(c, "U1", "com.acme.shop");
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.code).toBe("app_not_found");
	});
});

describe("appPid", () => {
	test("Android: pidof <pkg>", async () => {
		const { c, calls } = setup([["adb -s emulator-5554 shell pidof com.acme.shop", { stdout: "4242\n" }]]);
		expect(await appPid(c, { platform: "android", id: "emulator-5554" }, "com.acme.shop")).toBe(4242);
		expect(calls[0]).toEqual(["adb", "-s", "emulator-5554", "shell", "pidof", "com.acme.shop"]);
	});

	test("Android: not running → undefined", async () => {
		const { c } = setup([["adb -s emulator-5554 shell pidof", { stdout: "", exitCode: 1 }]]);
		expect(await appPid(c, { platform: "android", id: "emulator-5554" }, "com.acme.shop")).toBeUndefined();
	});

	test("iOS: the UIKitApplication row in launchctl list", async () => {
		const { c } = setup([
			[
				"xcrun simctl spawn U1 launchctl list",
				{
					stdout: [
						"PID\tStatus\tLabel",
						"101\t0\tcom.apple.springboard",
						"777\t0\tUIKitApplication:com.acme.shop[0x1a2b][rb-legacy]",
						"-\t0\tUIKitApplication:com.acme.other[0x3c4d][rb-legacy]",
					].join("\n"),
				},
			],
		]);
		expect(await appPid(c, { platform: "ios", id: "U1" }, "com.acme.shop")).toBe(777);
		expect(await appPid(c, { platform: "ios", id: "U1" }, "com.acme.other")).toBeUndefined();
	});
});
