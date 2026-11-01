import { describe, expect, test } from "bun:test";
import { openAdbSession } from "./adb-session";
import {
	bootProbeFor,
	hierarchyRotation,
	orientationToRotation,
	parseWmDensity,
	parseWmSize,
	readScreen,
	rotatedScreen,
	rotationToOrientation,
	screenFromProbe,
	sdkFromProbe,
	waitForBoot,
} from "./android-device";
import { fakeAndroidHost } from "./android-host.testing";

function fakeClock() {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
		elapsed: () => t,
	};
}

describe("wm parsers", () => {
	test("size prefers the override", () => {
		expect(parseWmSize("Physical size: 1080x2424\n")).toEqual({ width: 1080, height: 2424 });
		expect(parseWmSize("Physical size: 1080x2424\nOverride size: 720x1600\n")).toEqual({ width: 720, height: 1600 });
		expect(parseWmSize("garbage")).toBeUndefined();
	});

	test("density to scale", () => {
		expect(parseWmDensity("Physical density: 420\n")).toBe(2.625);
		expect(parseWmDensity("Physical density: 420\nOverride density: 320\n")).toBe(2);
		expect(parseWmDensity("")).toBeUndefined();
	});
});

describe("rotation helpers", () => {
	test("hierarchy rotation attribute", () => {
		expect(hierarchyRotation('<?xml ?><hierarchy rotation="1"><node/></hierarchy>')).toBe(1);
		expect(hierarchyRotation("<hierarchy>")).toBe(0);
	});

	test("rotatedScreen swaps on odd rotations", () => {
		const base = { width: 1080, height: 2424, scale: 2.6 };
		expect(rotatedScreen(base, 0)).toEqual({ ...base, rotation: 0 });
		expect(rotatedScreen(base, 1)).toEqual({ width: 2424, height: 1080, scale: 2.6, rotation: 1 });
		expect(rotatedScreen({ ...base, width: 2424, height: 1080 }, 2)).toEqual({ ...base, rotation: 2 });
	});

	test("orientation round trip", () => {
		for (const r of [0, 1, 2, 3] as const) expect(orientationToRotation(rotationToOrientation(r))).toBe(r);
	});
});

describe("screenFromProbe", () => {
	test("reads size and density from the combined output", () => {
		expect(screenFromProbe("1\nPhysical size: 1080x2424\nPhysical density: 420\n")).toEqual({
			width: 1080,
			height: 2424,
			scale: 2.625,
			rotation: 0,
		});
		expect(screenFromProbe("1\n")).toBeUndefined();
		expect(screenFromProbe("1\nPhysical size: 100x200\n")?.scale).toBe(1);
	});
});

describe("sdkFromProbe", () => {
	test("second line of the probe", () => {
		expect(sdkFromProbe("1\n34\nPhysical size: 1x2\n")).toBe(34);
		expect(sdkFromProbe("1\n\nPhysical size: 1x2\n")).toBeUndefined();
		expect(sdkFromProbe("1\n")).toBeUndefined();
	});
});

describe("device reads", () => {
	test("waitForBoot succeeds once the flag flips", async () => {
		let polls = 0;
		const host = fakeAndroidHost({
			shell: [{ match: "getprop sys.boot_completed", reply: () => (++polls >= 3 ? "1\n" : "\n") }],
		});
		const session = openAdbSession({ adb: "adb", serial: "s", spawn: host.spawn });
		const clock = fakeClock();
		expect((await waitForBoot(session, "s", clock)).success).toBe(true);
		expect(polls).toBe(3);
		expect(clock.elapsed()).toBe(1000);
		await session.close();
	});

	test("a console emulator gets the plain probe; any other serial also reads qemu props, wakefulness and keyguard", () => {
		expect(bootProbeFor("emulator-5554")).toBe(
			"getprop sys.boot_completed; getprop ro.build.version.sdk; wm size; wm density"
		);
		const phone = bootProbeFor("R5CT1234ABC");
		expect(phone.startsWith(bootProbeFor("emulator-5554"))).toBe(true);
		expect(phone).toContain("ro.boot.qemu");
		expect(phone).toContain("ro.kernel.qemu");
		expect(phone).toContain("mWakefulness");
	});

	test("waitForBoot reports a phone's facts, and none for a qemu device or a console emulator", async () => {
		const reply = (tail: string) => `1\n34\nPhysical size: 1080x2400\nPhysical density: 420\n${tail}`;
		const probe = async (serial: string, tail: string) => {
			const host = fakeAndroidHost({ shell: [{ match: "getprop sys.boot_completed", reply: reply(tail) }] });
			const session = openAdbSession({ adb: "adb", serial, spawn: host.spawn });
			const res = await waitForBoot(session, serial, fakeClock());
			await session.close();
			return res.success ? res.data.physical : "failed";
		};
		expect(await probe("R5CT", "wdn_qemu:\nmWakefulness=Asleep\n  showing=true\n  secure=true\n")).toEqual({
			awake: false,
			keyguardShowing: true,
			keyguardSecure: true,
		});
		expect(await probe("localhost:5555", "wdn_qemu:11\n")).toBeUndefined();
		expect(await probe("emulator-5554", "")).toBeUndefined();
	});

	test("waitForBoot gives E_NOT_BOOTED at the timeout", async () => {
		const host = fakeAndroidHost({ shell: [{ match: "getprop sys.boot_completed", reply: "0\n" }] });
		const session = openAdbSession({ adb: "adb", serial: "s", spawn: host.spawn });
		const clock = fakeClock();
		const res = await waitForBoot(session, "s", clock, { timeoutMs: 2000 });
		expect(!res.success && res.error.code).toBe("E_NOT_BOOTED");
		expect(clock.elapsed()).toBeGreaterThanOrEqual(2000);
		await session.close();
	});

	test("readScreen combines size and density", async () => {
		const host = fakeAndroidHost({
			shell: [
				{ match: "wm size", reply: "Physical size: 1080x2424\n" },
				{ match: "wm density", reply: "Physical density: 420\n" },
			],
		});
		const session = openAdbSession({ adb: "adb", serial: "s", spawn: host.spawn });
		expect(await readScreen(session, "s")).toEqual({
			success: true,
			data: { width: 1080, height: 2424, scale: 2.625, rotation: 0 },
		});
		await session.close();
	});

	test("readScreen reports unparseable wm output", async () => {
		const host = fakeAndroidHost({ shell: [{ match: "wm size", reply: "nope\n" }] });
		const session = openAdbSession({ adb: "adb", serial: "s", spawn: host.spawn });
		const res = await readScreen(session, "s");
		expect(!res.success && res.error.code).toBe("E_INTERNAL");
		await session.close();
	});
});
