import type { DriverResult, Logger, Orientation, ScreenInfo } from "../driver.types";
import { driverErr } from "../errors";
import type { AdbSession } from "./adb-session";
import { getpropArgv, type RotationValue, shellCommand, WM_DENSITY_ARGV, WM_SIZE_ARGV } from "./android-argv";

/** Device facts read once at open: boot flag, screen size/density. Pure parsers + small session helpers. */

export const BOOT_TIMEOUT_MS = 30_000;
const BOOT_POLL_MS = 500;

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

/** `wm size` prints `Physical size: WxH` and, when overridden, `Override size: WxH` (which wins). */
export function parseWmSize(text: string): { width: number; height: number } | undefined {
	const override = /Override size:\s*(\d+)x(\d+)/.exec(text);
	const physical = /Physical size:\s*(\d+)x(\d+)/.exec(text);
	const m = override ?? physical;
	if (!m) return undefined;
	return { width: Number(m[1]), height: Number(m[2]) };
}

/** `wm density`: `Physical density: 420` / `Override density: 320`; scale = dpi / 160. */
export function parseWmDensity(text: string): number | undefined {
	const m = /Override density:\s*(\d+)/.exec(text) ?? /Physical density:\s*(\d+)/.exec(text);
	return m ? Number(m[1]) / 160 : undefined;
}

/** Errors that retrying cannot fix (no adb binary, closed session). */
const isFatal = (error: { code: string }): boolean => error.code === "E_HELPER_MISSING" || error.code === "E_INTERNAL";

/** Boot flag + `wm size` + `wm density` in ONE round trip (a `warden ui` call opens a fresh driver every time). */
const BOOT_PROBE = `${shellCommand(getpropArgv("sys.boot_completed"))}; ${shellCommand(WM_SIZE_ARGV)}; ${shellCommand(WM_DENSITY_ARGV)}`;

/** The screen out of a boot probe's output, if `wm` answered. */
export function screenFromProbe(stdout: string): ScreenInfo | undefined {
	const size = parseWmSize(stdout);
	if (!size) return undefined;
	return { ...size, scale: parseWmDensity(stdout) ?? 1, rotation: 0 };
}

/**
 * Poll the boot probe until `sys.boot_completed` is `1`; `E_NOT_BOOTED` after `timeoutMs`. Returns the screen
 * from the same round trip (undefined when `wm` printed nothing parseable; use {@link readScreen}).
 */
export async function waitForBoot(
	session: AdbSession,
	serial: string,
	clock: Clock,
	opts: { timeoutMs?: number; log?: Logger } = {}
): DriverResult<ScreenInfo | undefined> {
	const timeoutMs = opts.timeoutMs ?? BOOT_TIMEOUT_MS;
	const deadline = clock.now() + timeoutMs;
	for (;;) {
		const res = await session.run(BOOT_PROBE, { timeoutMs: 5_000 });
		if (res.success && res.data.stdout.trimStart().startsWith("1")) {
			return { success: true, data: screenFromProbe(res.data.stdout) };
		}
		if (!res.success && isFatal(res.error)) return res;
		if (clock.now() >= deadline) {
			return driverErr("E_NOT_BOOTED", `${serial} did not report sys.boot_completed=1 within ${timeoutMs}ms`, {
				detail: res.success ? { stdout: res.data.stdout } : { error: res.error },
			});
		}
		opts.log?.(`waiting for ${serial} to boot`);
		await clock.sleep(BOOT_POLL_MS);
	}
}

/** Screen size + scale from `wm size` / `wm density`. */
export async function readScreen(session: AdbSession, serial: string): DriverResult<ScreenInfo> {
	const size = await session.run(shellCommand(WM_SIZE_ARGV));
	if (!size.success) return size;
	const parsed = parseWmSize(size.data.stdout);
	if (!parsed) {
		return driverErr("E_INTERNAL", `cannot parse \`wm size\` for ${serial}: ${size.data.stdout.trim().slice(0, 120)}`);
	}
	const density = await session.run(shellCommand(WM_DENSITY_ARGV));
	const scale = (density.success ? parseWmDensity(density.data.stdout) : undefined) ?? 1;
	return { success: true, data: { ...parsed, scale, rotation: 0 } };
}

/** Rotation reported by `<hierarchy rotation="N">` (0 when absent). */
export function hierarchyRotation(xml: string): number {
	const m = /<hierarchy[^>]*\brotation="(\d)"/.exec(xml);
	return m ? Number(m[1]) : 0;
}

/** The screen as drawn: width/height swap on 90/270 degree rotations. */
export function rotatedScreen(base: ScreenInfo, rotation: number): ScreenInfo {
	const landscape = rotation % 2 === 1;
	const portraitW = Math.min(base.width, base.height);
	const portraitH = Math.max(base.width, base.height);
	return {
		...base,
		width: landscape ? portraitH : portraitW,
		height: landscape ? portraitW : portraitH,
		rotation,
	};
}

/** Android `user_rotation` to `Orientation` (0 portrait, 1 landscapeLeft, 2 upside down, 3 landscapeRight). */
export function rotationToOrientation(rotation: number): Orientation {
	switch (rotation) {
		case 1:
			return "landscapeLeft";
		case 2:
			return "portraitUpsideDown";
		case 3:
			return "landscapeRight";
		default:
			return "portrait";
	}
}

export function orientationToRotation(orientation: Orientation): RotationValue {
	switch (orientation) {
		case "landscapeLeft":
			return 1;
		case "portraitUpsideDown":
			return 2;
		case "landscapeRight":
			return 3;
		case "portrait":
			return 0;
	}
}

/** Run one argv inside the session; a non-zero exit becomes `failure` (default `E_HID`) with the output as message. */
export async function runChecked(
	session: AdbSession,
	cmd: string,
	failure: "E_HID" | "E_IO" | "E_APP_UNAVAILABLE" | "E_UNSUPPORTED" | "E_BAD_REQUEST" = "E_HID",
	timeoutMs?: number
): DriverResult<string> {
	const res = await session.run(cmd, timeoutMs === undefined ? undefined : { timeoutMs });
	if (!res.success) return res;
	if (res.data.exitCode !== 0) {
		return driverErr(failure, `\`${cmd}\` exited ${res.data.exitCode}: ${res.data.stdout.trim().slice(0, 200)}`);
	}
	return { success: true, data: res.data.stdout };
}
