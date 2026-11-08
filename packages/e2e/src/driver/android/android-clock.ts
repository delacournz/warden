import type { ClockCondition } from "@delacour/warden-core/conditions/conditions.types";
import type { Exec } from "@delacour/warden-core/exec";
import type { ClockState, DriverResult } from "../driver.types";
import { driverErr } from "../errors";
import type { AdbSession } from "./adb-session";
import { shellCommand } from "./android-argv";

/**
 * Android mock clock: system time, device-wide. `settings put global auto_time 0` stops the network time sync from
 * undoing it, `cmd alarm set-time <epoch ms>` sets it (a shell-uid command on emulator images, verified on the
 * device's own `date`); where that does not take, `adb root` + `date -s @<secs>`. `real` is the undo in
 * `core/conditions/undo.ts`: `auto_time 1` then the host's time. There is no way to freeze Android's clock, so
 * `frozen` is `E_UNSUPPORTED`. Monotonic clocks are not affected by a wall-clock set.
 */

export const AUTO_TIME_OFF_ARGV: readonly string[] = ["settings", "put", "global", "auto_time", "0"];
export const AUTO_TIME_ON_ARGV: readonly string[] = ["settings", "put", "global", "auto_time", "1"];
export const DATE_ARGV: readonly string[] = ["date", "+%s"];

export const setTimeArgv = (epochMs: number): string[] => ["cmd", "alarm", "set-time", String(Math.trunc(epochMs))];

/** How far the device's `date` may be from the target (it only reports whole seconds, and a call takes time). */
export const CLOCK_TOLERANCE_MS = 5_000;

export type AndroidClockDeps = {
	session: AdbSession;
	/** host runner for the `adb root` fallback */
	exec: Exec;
	adb: string;
	serial: string;
	/** host wall time, ms (default `Date.now`) */
	wallNow?: () => number;
};

async function shell(deps: AndroidClockDeps, argv: readonly string[]): Promise<{ ok: boolean; stdout: string }> {
	const res = await deps.session.run(shellCommand(argv));
	return res.success ? { ok: res.data.exitCode === 0, stdout: res.data.stdout } : { ok: false, stdout: "" };
}

/** The device's wall time in ms (whole seconds), or undefined when `date` printed something else. */
async function deviceNowMs(deps: AndroidClockDeps): Promise<number | undefined> {
	const out = await shell(deps, DATE_ARGV);
	const secs = Number(out.stdout.trim());
	return out.ok && Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined;
}

/** Set the time as root: `adb root`, wait for the device, `date -s @<secs>`. */
async function setAsRoot(deps: AndroidClockDeps, epochMs: number): Promise<boolean> {
	const base = [deps.adb, "-s", deps.serial];
	const rooted = await deps.exec([...base, "root"]);
	if (rooted.exitCode !== 0) return false;
	await deps.exec([...base, "wait-for-device"]);
	const set = await deps.exec([...base, "shell", "date", "-s", `@${Math.floor(epochMs / 1000)}`]);
	return set.exitCode === 0;
}

/** The epoch ms `condition` means given the host time, or a `E_BAD_REQUEST` for an unreadable instant. */
function targetMs(condition: ClockCondition, hostNow: number): { target: number } | { error: string } {
	if (condition.kind === "offset") return { target: hostNow + Math.trunc(condition.ms) };
	if (condition.kind !== "fixed" && condition.kind !== "frozen") return { target: hostNow };
	const at = Date.parse(condition.at);
	return Number.isNaN(at)
		? { error: `clock ${condition.kind}: "${condition.at}" is not an ISO 8601 date-time` }
		: { target: at };
}

/** Read the clock back; if it is not at `target`, retry as root and read again. */
async function settleAt(deps: AndroidClockDeps, target: number): Promise<number | undefined> {
	const near = (ms: number | undefined): ms is number =>
		ms !== undefined && Math.abs(ms - target) <= CLOCK_TOLERANCE_MS;
	const read = await deviceNowMs(deps);
	if (near(read)) return read;
	if (!(await setAsRoot(deps, target))) return undefined;
	const again = await deviceNowMs(deps);
	return near(again) ? again : undefined;
}

/** Put the emulator's wall clock at `condition`; reads it back and fails with `E_IO` when it did not move. */
export async function applyAndroidClock(deps: AndroidClockDeps, condition: ClockCondition): DriverResult<ClockState> {
	if (!deps.serial.startsWith("emulator-")) {
		return driverErr("E_UNSUPPORTED", `clock conditions need an emulator; ${deps.serial} is not one`);
	}
	if (condition.kind === "frozen") {
		return driverErr(
			"E_UNSUPPORTED",
			"Android cannot freeze its clock: use `fixed` (the clock starts at that instant and runs); `frozen` is iOS only"
		);
	}
	const hostNow = (deps.wallNow ?? Date.now)();
	const resolved = targetMs(condition, hostNow);
	if ("error" in resolved) return driverErr("E_BAD_REQUEST", resolved.error);
	const { target } = resolved;
	await shell(deps, condition.kind === "real" ? AUTO_TIME_ON_ARGV : AUTO_TIME_OFF_ARGV);
	await shell(deps, setTimeArgv(target));
	if ((await settleAt(deps, target)) === undefined) {
		return driverErr(
			"E_IO",
			`the device clock did not move to ${new Date(target).toISOString()} (\`cmd alarm set-time\` and \`adb root\` + \`date\` both failed)`,
			{ detail: { serial: deps.serial } }
		);
	}
	return { success: true, data: { condition, offsetMs: target - hostNow, frozen: false, nowMs: target } };
}
