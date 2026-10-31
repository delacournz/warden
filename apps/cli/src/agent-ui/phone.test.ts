import { afterEach, describe, expect, test } from "bun:test";
import { recordInstall } from "@delacour/warden-core/builds/cache";
import { PHONE_PROBE_SCRIPT } from "@delacour/warden-core/providers/android";
import { ADB_DEVICES_STATES, EMULATOR_PROPS, PHONE_PROPS } from "@delacour/warden-core/providers/android.fixtures";
import { fakeExec, type TestContext, testContext } from "../testing";
import { checkPhone, ownedPackages, phoneStateError } from "./phone";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function setup(calls: string[][] = []): TestContext {
	ctx = testContext([], {
		exec: fakeExec(
			[
				["adb devices -l", { stdout: ADB_DEVICES_STATES }],
				[`adb -s R5CT1234ABC shell ${PHONE_PROBE_SCRIPT}`, { stdout: PHONE_PROPS }],
				[`adb -s localhost:5555 shell ${PHONE_PROBE_SCRIPT}`, { stdout: EMULATOR_PROPS }],
			],
			calls
		),
	});
	return ctx;
}

describe("checkPhone", () => {
	test("a ready phone: usb transport and its hardware serial", async () => {
		expect(await checkPhone(setup(), "R5CT1234ABC")).toEqual({
			kind: "phone",
			adbState: "device",
			physical: { transport: "usb", hwSerial: "R5CT1234ABC" },
		});
	});

	test("an unauthorized phone is a phone in that state, without asking it anything else", async () => {
		const calls: string[][] = [];
		const result = await checkPhone(setup(calls), "0123456789ABCDEF");
		expect(result).toEqual({ kind: "phone", adbState: "unauthorized", physical: { transport: "usb" } });
		expect(calls.map((c) => c.join(" "))).toEqual(["adb devices -l"]);
	});

	test("a qemu network emulator, a console emulator and an unlisted serial are not phones", async () => {
		const calls: string[][] = [];
		const c = setup(calls);
		expect(await checkPhone(c, "localhost:5555")).toEqual({ kind: "other" });
		expect(await checkPhone(c, "emulator-5554")).toEqual({ kind: "other" });
		expect(await checkPhone(c, "NOT-LISTED")).toEqual({ kind: "other" });
	});

	test("adb missing is not a phone, not a crash", async () => {
		ctx = testContext([], { exec: fakeExec([]) });
		expect(await checkPhone(ctx, "R5CT1234ABC")).toEqual({ kind: "other" });
	});
});

describe("phoneStateError", () => {
	test("device is fine; unauthorized and offline are exit-2 codes with a hint", () => {
		expect(phoneStateError("X", "device")).toBeUndefined();
		expect(phoneStateError("X", "unauthorized")).toMatchObject({ code: "device_unauthorized" });
		expect(phoneStateError("X", "authorizing")?.code).toBe("device_unauthorized");
		expect(phoneStateError("X", "offline")).toMatchObject({ code: "device_offline", details: { adbState: "offline" } });
		expect(phoneStateError("X", "no permissions")?.code).toBe("device_offline");
		expect(phoneStateError("X", "offline")?.hint).toBeDefined();
	});
});

describe("ownedPackages", () => {
	test("WARDEN_BUNDLE_ID plus what the installs table holds for that serial", () => {
		const c = setup();
		c.env = { ...c.env, WARDEN_BUNDLE_ID: "com.app" };
		recordInstall(c.db, { platform: "android", deviceId: "R5CT", bundleId: "com.extra", hash: "h", installedAt: 1 });
		recordInstall(c.db, { platform: "android", deviceId: "OTHER", bundleId: "com.nope", hash: "h", installedAt: 1 });
		expect(ownedPackages(c, "R5CT").sort()).toEqual(["com.app", "com.extra"]);
	});

	test("nothing is owned by default", () => {
		expect(ownedPackages(setup(), "R5CT")).toEqual([]);
	});
});
