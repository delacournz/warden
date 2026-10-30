import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../exec";
import { enrollFingerprint, findTapTarget, isPinEntry, parseFingerprintEnrolled } from "./android-biometrics";

const out = (stdout: string, exitCode = 0): ExecResult => ({ exitCode, stdout, stderr: "" });
const ENROLLED = '{"service":"Fingerprint Manager","prints":[{"id":0,"count":1,"accept":0,"reject":0}]}';
const EMPTY = '{"service":"Fingerprint Manager","prints":[{"id":0,"count":0,"accept":0,"reject":0}]}';

const node = (text: string, bounds: string, extra = "") =>
	`<node index="0" text="${text}" resource-id="${extra}" class="android.widget.Button" clickable="true" bounds="${bounds}" />`;
const screen = (...nodes: string[]) => `<?xml version='1.0'?><hierarchy rotation="0">${nodes.join("")}</hierarchy>`;

const REAL_ENROLLED = `Dumping for sensorId: 0, provider: FingerprintProvider
Fps state: 0
{"service":"FingerprintProvider\\/default","prints":[{"id":0,"count":1,"accept":0,"reject":0,"acquire":0,"lockout":0,"permanentLockout":0,"acceptCrypto":0,"rejectCrypto":0,"acquireCrypto":0}]}
HAL deaths since last reboot: 0
`;

describe("parseFingerprintEnrolled", () => {
	test("real Pixel_10 (API 36) dump after enrollment", () => {
		expect(parseFingerprintEnrolled(REAL_ENROLLED)).toBe(true);
		expect(parseFingerprintEnrolled(REAL_ENROLLED.replace('"count":1', '"count":0'))).toBe(false);
	});

	test("JSON counts, legacy lines, none", () => {
		expect(parseFingerprintEnrolled(ENROLLED)).toBe(true);
		expect(parseFingerprintEnrolled(EMPTY)).toBe(false);
		expect(parseFingerprintEnrolled("Fingerprint Manager\n  Enrolled fingerprints: 2\n")).toBe(true);
		expect(parseFingerprintEnrolled("Fingerprint Manager\n  prints: 0\n")).toBe(false);
		expect(parseFingerprintEnrolled("")).toBe(false);
	});
});

describe("wizard screens", () => {
	test("tap target: centre of the first matching button, case-insensitive, whole text", () => {
		const xml = screen(node("Cancel", "[0,0][100,50]"), node("Next", "[200,1000][400,1100]"));
		expect(findTapTarget(xml)).toEqual({ label: "Next", x: 300, y: 1050 });
		expect(findTapTarget(screen(node("Skip", "[0,0][10,10]")))).toBeUndefined();
		expect(findTapTarget(screen(node("I agree", "[0,0][10,10]")))?.label).toBe("I agree");
	});

	test("pin entry screen is recognised by its entry field", () => {
		expect(isPinEntry(screen(node("", "[0,0][10,10]", "com.android.settings:id/password_entry")))).toBe(true);
		expect(isPinEntry(screen(node("Next", "[0,0][10,10]")))).toBe(false);
	});
});

describe("enrollFingerprint", () => {
	type Script = { enrolledAfterTouches: number };
	function fake(script: Script) {
		const calls: string[][] = [];
		let touches = 0;
		let screens = 0;
		const exec: Exec = async (cmd) => {
			calls.push([...cmd]);
			const line = cmd.join(" ");
			if (line.endsWith("dumpsys fingerprint")) return out(touches >= script.enrolledAfterTouches ? ENROLLED : EMPTY);
			if (line.includes("emu finger touch")) {
				touches++;
				return out("OK");
			}
			if (line.endsWith("shell cat /sdcard/warden-ui.xml")) {
				screens++;
				return out(
					screens === 1 ? screen(node("", "[0,0][1,1]", "id/password_entry")) : screen(node("Next", "[10,10][30,30]"))
				);
			}
			return out("");
		};
		return { exec, calls, touches: () => touches };
	}
	const deps = (exec: Exec) => ({ exec, sleep: async () => {}, adb: "adb" });

	test("already enrolled: nothing is touched", async () => {
		const f = fake({ enrolledAfterTouches: 0 });
		const result = await enrollFingerprint(deps(f.exec), "emulator-5554");
		expect(result).toEqual({ success: true, data: { alreadyEnrolled: true } });
		expect(f.calls.filter((c) => c.join(" ").includes("locksettings"))).toHaveLength(0);
	});

	test("sets the PIN, opens the wizard, enters the PIN, touches until enrolled", async () => {
		const f = fake({ enrolledAfterTouches: 3 });
		const result = await enrollFingerprint(deps(f.exec), "emulator-5554");
		expect(result).toEqual({ success: true, data: { alreadyEnrolled: false } });
		const lines = f.calls.map((c) => c.join(" "));
		expect(lines.some((l) => l.endsWith("shell locksettings set-pin 1111"))).toBe(true);
		expect(lines.some((l) => l.endsWith("shell am start -a android.settings.FINGERPRINT_ENROLL"))).toBe(true);
		expect(lines.some((l) => l.endsWith("shell input text 1111"))).toBe(true);
		expect(lines.some((l) => l.includes("input tap 20 20"))).toBe(true);
		expect(f.touches()).toBe(3);
		expect(f.calls.every((c) => c.includes("-s") && c.includes("emulator-5554"))).toBe(true);
	});

	test("never enrolling gives up with an error naming the serial", async () => {
		const f = fake({ enrolledAfterTouches: 999 });
		const result = await enrollFingerprint({ ...deps(f.exec), maxSteps: 4 }, "emulator-5554");
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("emulator-5554");
	});

	test("refuses a non-emulator serial", async () => {
		const f = fake({ enrolledAfterTouches: 0 });
		const result = await enrollFingerprint(deps(f.exec), "R58M123ABC");
		expect(result.success).toBe(false);
		expect(f.calls).toHaveLength(0);
	});
});
