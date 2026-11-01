import type { DriverResult, Logger, Orientation, ScreenInfo } from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import type { AdbSession } from "./adb-session";
import { androidArgv, type RotationValue, WM_DENSITY_ARGV, WM_SIZE_ARGV } from "./android-argv";
import { androidPhone, PHONE_PROBE_TAIL, type PhoneFacts } from "./android-phone";

/** Device facts read once at open: boot flag, screen size/density. Pure parsers + small session helpers. */

export const BOOT_TIMEOUT_MS = 30_000;
const BOOT_POLL_MS = 500;

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

/** Boot flag + sdk level + `wm size` + `wm density` in ONE round trip (a `warden ui` call opens a fresh driver every time). */
const BOOT_PROBE = [
	androidArgv.getpropArgv("sys.boot_completed"),
	androidArgv.getpropArgv("ro.build.version.sdk"),
	WM_SIZE_ARGV,
	WM_DENSITY_ARGV,
]
	.map((argv) => androidArgv.shellCommand(argv))
	.join("; ");

/** `physical`: set only for a real phone (its qemu props are empty); an emulator, or an unprobed serial, has none. */
export type BootInfo = { screen: ScreenInfo | undefined; sdk: number | undefined; physical: PhoneFacts | undefined };

/** Device facts: parsers for `wm`, the boot probe, rotation mappings, and the session helpers that read them. */
export class AndroidDevice {
	/** `wm size` prints `Physical size: WxH` and, when overridden, `Override size: WxH` (which wins). */
	parseWmSize(text: string): { width: number; height: number } | undefined {
		const override = /Override size:\s*(\d+)x(\d+)/.exec(text);
		const physical = /Physical size:\s*(\d+)x(\d+)/.exec(text);
		const m = override ?? physical;
		if (!m) return undefined;
		return { width: Number(m[1]), height: Number(m[2]) };
	}

	/** `wm density`: `Physical density: 420` / `Override density: 320`; scale = dpi / 160. */
	parseWmDensity(text: string): number | undefined {
		const m = /Override density:\s*(\d+)/.exec(text) ?? /Physical density:\s*(\d+)/.exec(text);
		return m ? Number(m[1]) / 160 : undefined;
	}

	/**
	 * The probe for `serial`. A console `emulator-N` is an emulator by construction. Anything else (a phone, or a
	 * network emulator) also reads the qemu props, wakefulness and keyguard, in the same round trip.
	 */
	bootProbeFor(serial: string): string {
		return /^emulator-\d+$/.test(serial) ? BOOT_PROBE : `${BOOT_PROBE}; ${PHONE_PROBE_TAIL}`;
	}

	/** The sdk level on the probe's second line, if numeric. */
	sdkFromProbe(stdout: string): number | undefined {
		const line = stdout.trimStart().split("\n")[1]?.trim() ?? "";
		return /^\d+$/.test(line) ? Number(line) : undefined;
	}

	/** The screen out of a boot probe's output, if `wm` answered. */
	screenFromProbe(stdout: string): ScreenInfo | undefined {
		const size = this.parseWmSize(stdout);
		if (!size) return undefined;
		return { ...size, scale: this.parseWmDensity(stdout) ?? 1, rotation: 0 };
	}

	/**
	 * Poll the boot probe until `sys.boot_completed` is `1`; `E_NOT_BOOTED` after `timeoutMs`. Returns the screen
	 * and sdk level from the same round trip (screen undefined when `wm` printed nothing parseable; use {@link readScreen}).
	 */
	async waitForBoot(
		session: AdbSession,
		serial: string,
		clock: Clock,
		opts: { timeoutMs?: number; log?: Logger } = {}
	): DriverResult<BootInfo> {
		const timeoutMs = opts.timeoutMs ?? BOOT_TIMEOUT_MS;
		const probe = this.bootProbeFor(serial);
		const deadline = clock.now() + timeoutMs;
		for (;;) {
			const res = await session.run(probe, { timeoutMs: 5_000 });
			if (res.success && res.data.stdout.trimStart().startsWith("1")) {
				return {
					success: true,
					data: {
						screen: this.screenFromProbe(res.data.stdout),
						sdk: this.sdkFromProbe(res.data.stdout),
						physical: androidPhone.parsePhoneFacts(res.data.stdout),
					},
				};
			}
			if (!res.success && this.isFatal(res.error)) return res;
			if (clock.now() >= deadline) {
				return driverErrors.err("E_NOT_BOOTED", `${serial} did not report sys.boot_completed=1 within ${timeoutMs}ms`, {
					detail: res.success ? { stdout: res.data.stdout } : { error: res.error },
				});
			}
			opts.log?.(`waiting for ${serial} to boot`);
			await clock.sleep(BOOT_POLL_MS);
		}
	}

	/** Screen size + scale from `wm size` / `wm density`. */
	async readScreen(session: AdbSession, serial: string): DriverResult<ScreenInfo> {
		const size = await session.run(androidArgv.shellCommand(WM_SIZE_ARGV));
		if (!size.success) return size;
		const parsed = this.parseWmSize(size.data.stdout);
		if (!parsed) {
			return driverErrors.err(
				"E_INTERNAL",
				`cannot parse \`wm size\` for ${serial}: ${size.data.stdout.trim().slice(0, 120)}`
			);
		}
		const density = await session.run(androidArgv.shellCommand(WM_DENSITY_ARGV));
		const scale = (density.success ? this.parseWmDensity(density.data.stdout) : undefined) ?? 1;
		return { success: true, data: { ...parsed, scale, rotation: 0 } };
	}

	/** Rotation reported by `<hierarchy rotation="N">` (0 when absent). */
	hierarchyRotation(xml: string): number {
		const m = /<hierarchy[^>]*\brotation="(\d)"/.exec(xml);
		return m ? Number(m[1]) : 0;
	}

	/** The screen as drawn: width/height swap on 90/270 degree rotations. */
	rotatedScreen(base: ScreenInfo, rotation: number): ScreenInfo {
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
	rotationToOrientation(rotation: number): Orientation {
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

	orientationToRotation(orientation: Orientation): RotationValue {
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
	async runChecked(
		session: AdbSession,
		cmd: string,
		failure: "E_HID" | "E_IO" | "E_APP_UNAVAILABLE" | "E_UNSUPPORTED" | "E_BAD_REQUEST" = "E_HID",
		timeoutMs?: number
	): DriverResult<string> {
		const res = await session.run(cmd, timeoutMs === undefined ? undefined : { timeoutMs });
		if (!res.success) return res;
		if (res.data.exitCode !== 0) {
			return driverErrors.err(
				failure,
				`\`${cmd}\` exited ${res.data.exitCode}: ${res.data.stdout.trim().slice(0, 200)}`
			);
		}
		return { success: true, data: res.data.stdout };
	}

	/** Errors that retrying cannot fix (no adb binary, closed session). */
	private isFatal(error: { code: string }): boolean {
		return error.code === "E_HELPER_MISSING" || error.code === "E_INTERNAL";
	}
}

export const androidDevice = new AndroidDevice();
