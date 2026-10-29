import { describe, expect, test } from "bun:test";
import { openAdbSession } from "./adb-session";
import { fakeAndroidHost, type ShellRule } from "./android-host.testing";
import {
	createSettingsGuard,
	KEYGUARD_COMMAND,
	PHONE_PROBE_TAIL,
	parsePhoneFacts,
	preparePhone,
} from "./android-phone";
import { memoryAndroidState } from "./android-state";

const clock = () => {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
	};
};

const PHONE_TAIL = "wdn_qemu:\nmWakefulness=Awake\n  showing=false\n  secure=true\n";

function session(rules: ShellRule[]) {
	const host = fakeAndroidHost({ shell: rules });
	return { host, session: openAdbSession({ adb: "adb", serial: "R5CT", spawn: host.spawn }) };
}

describe("parsePhoneFacts", () => {
	test("no marker: not probed (an emulator serial)", () => {
		expect(parsePhoneFacts("1\n34\nPhysical size: 1080x2400\n")).toBeUndefined();
	});

	test("qemu=1 on either prop means an emulator, not a phone", () => {
		expect(parsePhoneFacts("wdn_qemu:1\nmWakefulness=Awake\n")).toBeUndefined();
		expect(parsePhoneFacts("wdn_qemu:01\n")).toBeUndefined();
		expect(parsePhoneFacts("wdn_qemu:1\n")).toBeUndefined();
	});

	test("a phone: wakefulness and keyguard facts", () => {
		expect(parsePhoneFacts(PHONE_TAIL)).toEqual({ awake: true, keyguardShowing: false, keyguardSecure: true });
		expect(parsePhoneFacts("wdn_qemu:\nmWakefulness=Asleep\n  showing=true\n  secure=false\n")).toEqual({
			awake: false,
			keyguardShowing: true,
			keyguardSecure: false,
		});
	});

	test("unreadable dumpsys leaves the facts unknown", () => {
		expect(parsePhoneFacts("wdn_qemu:\n")).toEqual({});
	});

	test("the probe tail reads the qemu props, wakefulness and keyguard", () => {
		expect(PHONE_PROBE_TAIL).toContain("ro.boot.qemu");
		expect(PHONE_PROBE_TAIL).toContain("ro.kernel.qemu");
		expect(PHONE_PROBE_TAIL).toContain("mWakefulness");
		expect(PHONE_PROBE_TAIL).toContain("dumpsys window policy");
	});
});

describe("preparePhone", () => {
	test("an awake, unlocked phone is left alone", async () => {
		const { host, session: s } = session([]);
		const res = await preparePhone(s, clock(), { awake: true, keyguardShowing: false, keyguardSecure: false });
		expect(res.success).toBe(true);
		expect(host.shell).toEqual([]);
		await s.close();
	});

	test("a sleeping phone is woken with KEYCODE_WAKEUP, then the keyguard is read again", async () => {
		const { host, session: s } = session([{ match: KEYGUARD_COMMAND, reply: "  showing=false\n  secure=true\n" }]);
		const res = await preparePhone(s, clock(), { awake: false });
		expect(res.success).toBe(true);
		expect(host.shell).toEqual(["input keyevent 224", KEYGUARD_COMMAND]);
		await s.close();
	});

	test("a non-secure keyguard is dismissed", async () => {
		const { host, session: s } = session([]);
		const res = await preparePhone(s, clock(), { awake: true, keyguardShowing: true, keyguardSecure: false });
		expect(res.success).toBe(true);
		expect(host.shell).toEqual(["wm dismiss-keyguard"]);
		await s.close();
	});

	test("a secure keyguard is E_DEVICE_LOCKED, with nothing typed or swiped", async () => {
		const { host, session: s } = session([{ match: KEYGUARD_COMMAND, reply: "  showing=true\n  secure=true\n" }]);
		const res = await preparePhone(s, clock(), { awake: false });
		expect(!res.success && res.error.code).toBe("E_DEVICE_LOCKED");
		expect(!res.success && res.error.message).toContain("unlock");
		expect(host.shell.some((c) => c.startsWith("input swipe") || c.startsWith("input text"))).toBe(false);
		expect(host.shell.some((c) => c.includes("dismiss-keyguard"))).toBe(false);
		await s.close();
	});
});

describe("createSettingsGuard", () => {
	const READ_ROTATION: ShellRule[] = [
		{ match: "settings get system accelerometer_rotation", reply: "1\n" },
		{ match: "settings get system user_rotation", reply: "null\n" },
		{ match: "cmd uimode night", reply: "Night mode: auto\n" },
	];

	test("remembers the originals before the first write and puts them back on restore", async () => {
		const { host, session: s } = session(READ_ROTATION);
		const state = memoryAndroidState();
		const guard = await createSettingsGuard({ session: s, serial: "R5CT", sdk: 34, state, pending: {} });
		await guard.beforeRotate();
		await guard.beforeRotate();
		await guard.beforeAppearance();
		expect(await state.read("R5CT")).toMatchObject({
			rotation: { accelerometer_rotation: "1", user_rotation: "null" },
			uimode: "auto",
		});
		expect(host.shell.filter((c) => c.startsWith("settings get system"))).toHaveLength(2);
		await guard.restore();
		expect(host.shell.slice(-3)).toEqual([
			"settings put system accelerometer_rotation 1",
			"settings delete system user_rotation",
			"cmd uimode night auto",
		]);
		const after = await state.read("R5CT");
		expect(after.rotation).toBeUndefined();
		expect(after.uimode).toBeUndefined();
		await s.close();
	});

	test("restore without any write sends nothing", async () => {
		const { host, session: s } = session(READ_ROTATION);
		const guard = await createSettingsGuard({ session: s, serial: "R5CT", sdk: 34, pending: {} });
		await guard.restore();
		expect(host.shell).toEqual([]);
		await s.close();
	});

	test("originals a crashed process left are restored by the next driver, and are not overwritten", async () => {
		const { host, session: s } = session(READ_ROTATION);
		const guard = await createSettingsGuard({
			session: s,
			serial: "R5CT",
			sdk: 34,
			pending: { rotation: { accelerometer_rotation: "1", user_rotation: "0" }, uimode: "no" },
		});
		await guard.beforeRotate();
		await guard.beforeAppearance();
		expect(host.shell).toEqual([]);
		await guard.restore();
		expect(host.shell).toEqual([
			"settings put system accelerometer_rotation 1",
			"settings put system user_rotation 0",
			"cmd uimode night no",
		]);
		await s.close();
	});

	test("a failed restore keeps the originals in the state file for the next driver", async () => {
		const { session: s } = session([
			...READ_ROTATION,
			{ match: "settings put system", reply: { stdout: "boom", exitCode: 1 } },
		]);
		const state = memoryAndroidState();
		const guard = await createSettingsGuard({ session: s, serial: "R5CT", sdk: 34, state, pending: {} });
		await guard.beforeRotate();
		await guard.restore();
		expect((await state.read("R5CT")).rotation).toEqual({ accelerometer_rotation: "1", user_rotation: "null" });
		await s.close();
	});
});
