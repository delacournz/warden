import { describe, expect, test } from "bun:test";
import {
	ensureUnlocked,
	parseKeyguardShowing,
	STAY_AWAKE_COMMAND,
	SYSTEMUI_RESTART_COMMAND,
	systemReady,
	unlockCommand,
} from "./android-keyguard";
import type { Exec, ExecResult } from "./exec";

const out = (stdout: string, exitCode = 0): ExecResult => ({ exitCode, stdout, stderr: "" });
const SHOWING = "    mShowingDream=false mDreamingLockscreen=true\n    isKeyguardShowing=true\n";
const GONE = "    mShowingDream=false mDreamingLockscreen=false\n    isKeyguardShowing=false\n";
const ADB = "adb";
const S = "emulator-5554";
const DUMP = `${ADB} -s ${S} shell dumpsys window`;

describe("parseKeyguardShowing", () => {
	test("real API 36 dumpsys window lines", () => {
		expect(parseKeyguardShowing(SHOWING)).toBe(true);
		expect(parseKeyguardShowing(GONE)).toBe(false);
		expect(parseKeyguardShowing("nothing")).toBeUndefined();
	});
});

describe("unlockCommand", () => {
	test("wakes, swipes the lock screen up, types the PIN", () => {
		const cmd = unlockCommand();
		expect(cmd).toContain("input keyevent 224");
		expect(cmd).toContain("input swipe");
		expect(cmd).toContain("input text 1111");
	});
});

/** adb fake: `dumpsys window` answers from `states`, one per call (the last repeats); everything else succeeds. */
function fake(states: string[]) {
	const calls: string[] = [];
	let i = 0;
	const exec: Exec = async (cmd) => {
		const line = cmd.join(" ");
		calls.push(line);
		if (line === DUMP) return out(states[Math.min(i++, states.length - 1)] ?? "");
		return out("");
	};
	return { exec, calls };
}
const deps = (exec: Exec) => ({ exec, sleep: async () => {}, adb: ADB });

describe("ensureUnlocked", () => {
	test("already unlocked: only keeps the screen awake, no PIN typed", async () => {
		const { exec, calls } = fake([GONE]);
		expect((await ensureUnlocked(deps(exec), S)).success).toBe(true);
		expect(calls).toContain(`${ADB} -s ${S} shell ${STAY_AWAKE_COMMAND}`);
		expect(calls.some((c) => c.includes("input text"))).toBe(false);
	});

	test("locked: unlocks, re-reads, then stays awake", async () => {
		const { exec, calls } = fake([SHOWING, GONE]);
		expect((await ensureUnlocked(deps(exec), S)).success).toBe(true);
		expect(calls.filter((c) => c.includes(unlockCommand()))).toHaveLength(1);
		expect(calls.some((c) => c.includes(SYSTEMUI_RESTART_COMMAND))).toBe(false);
	});

	test("a lock screen that ignores the PIN gets SystemUI restarted before the last attempt", async () => {
		const { exec, calls } = fake([SHOWING, SHOWING, SHOWING, GONE]);
		expect((await ensureUnlocked(deps(exec), S)).success).toBe(true);
		const restart = calls.findIndex((c) => c.includes(SYSTEMUI_RESTART_COMMAND));
		const unlocks = calls.map((c, n) => (c.includes(unlockCommand()) ? n : -1)).filter((n) => n >= 0);
		expect(unlocks).toHaveLength(3);
		expect(restart).toBeGreaterThan(unlocks[1] as number);
		expect(restart).toBeLessThan(unlocks[2] as number);
	});

	test("still locked after the attempts: an error naming the keyguard", async () => {
		const { exec } = fake([SHOWING]);
		const result = await ensureUnlocked(deps(exec), S);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("keyguard");
	});

	test("refuses a non-emulator serial", async () => {
		const { exec, calls } = fake([GONE]);
		expect((await ensureUnlocked(deps(exec), "R5CT123")).success).toBe(false);
		expect(calls).toEqual([]);
	});
});

describe("systemReady", () => {
	test("needs adb state device and `pm path android` to succeed, retrying within the bound", async () => {
		let pm = 0;
		const exec: Exec = async (cmd) => {
			const line = cmd.join(" ");
			if (line === `${ADB} -s ${S} get-state`) return out("device\n");
			if (line === `${ADB} -s ${S} shell pm path android`)
				return ++pm >= 3
					? out("package:/system/framework/framework-res.apk\n")
					: out("Error: Could not access the Package Manager", 1);
			return out("");
		};
		expect((await systemReady(deps(exec), S, 60_000)).success).toBe(true);
		expect(pm).toBe(3);
	});

	test("offline for good: an error after the bound", async () => {
		let t = 0;
		const exec: Exec = async (cmd) => (cmd.join(" ") === `${ADB} -s ${S} get-state` ? out("offline\n") : out("", 1));
		const result = await systemReady(
			{
				...deps(exec),
				now: () => t,
				sleep: async (ms) => {
					t += ms;
				},
			},
			S,
			5_000
		);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("offline");
	});
});
