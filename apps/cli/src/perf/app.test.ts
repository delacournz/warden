import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeExec, type TestContext, testContext } from "../testing";
import { foregroundApp, resolveApp } from "./app";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const fx = (name: string) =>
	readFileSync(join(import.meta.dir, "..", "..", "..", "..", "packages", "perf", "fixtures", name), "utf8");

function setup(handlers: Array<[string, { stdout: string }]>): { c: TestContext; calls: string[][] } {
	const calls: string[][] = [];
	ctx = testContext([], { exec: fakeExec(handlers, calls) });
	return { c: ctx, calls };
}

const ios = { platform: "ios", id: "U1" } as const;
const android = { platform: "android", id: "emulator-5554" } as const;

describe("foregroundApp", () => {
	test("iOS: the one running non-system app from launchctl list", async () => {
		const { c, calls } = setup([["xcrun simctl spawn U1 launchctl list", { stdout: fx("launchctl-list.txt") }]]);
		expect(await foregroundApp(c, ios)).toBe("nz.co.delacour.warden.example");
		expect(calls[0]).toEqual(["xcrun", "simctl", "spawn", "U1", "launchctl", "list"]);
	});

	test("Android: the resumed activity's package", async () => {
		const { c, calls } = setup([
			["adb -s emulator-5554 shell dumpsys activity activities", { stdout: fx("dumpsys-resumed.txt") }],
		]);
		expect(await foregroundApp(c, android)).toBe("nz.co.delacour.warden.example");
		expect(calls[0]).toEqual(["adb", "-s", "emulator-5554", "shell", "dumpsys", "activity", "activities"]);
	});

	test("undefined when nothing is detected", async () => {
		const { c } = setup([["xcrun simctl spawn", { stdout: "PID\tStatus\tLabel\n" }]]);
		expect(await foregroundApp(c, ios)).toBeUndefined();
	});
});

describe("resolveApp", () => {
	test("--app wins and skips detection", async () => {
		const { c, calls } = setup([]);
		const r = await resolveApp(c, ios, "com.acme.shop");
		expect(r).toEqual({ success: true, data: { id: "com.acme.shop", source: "flag" } });
		expect(calls).toEqual([]);
	});

	test("falls back to the foreground app", async () => {
		const { c } = setup([["xcrun simctl spawn", { stdout: fx("launchctl-list.txt") }]]);
		const r = await resolveApp(c, ios, undefined);
		expect(r).toEqual({ success: true, data: { id: "nz.co.delacour.warden.example", source: "foreground" } });
	});

	test("several user apps: app_not_found listing them", async () => {
		const { c } = setup([["xcrun simctl spawn", { stdout: fx("launchctl-list-two-apps.txt") }]]);
		const r = await resolveApp(c, ios, undefined);
		expect(r.success).toBe(false);
		if (r.success) return;
		expect(r.error.code).toBe("app_not_found");
		expect(r.error.message).toContain("com.acme.other");
		expect(r.error.hint).toContain("--app");
	});

	test("nothing detected and no config: app_not_found with the --app hint", async () => {
		const { c } = setup([["xcrun simctl spawn", { stdout: "PID\tStatus\tLabel\n" }]]);
		const r = await resolveApp(c, ios, undefined);
		expect(r).toMatchObject({ success: false, error: { code: "app_not_found" } });
	});
});
