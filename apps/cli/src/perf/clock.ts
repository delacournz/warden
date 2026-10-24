import { androidTools } from "@delacour/warden-core/providers/android";
import type { Platform } from "@delacour/warden-core/types";
import type { CommandContext } from "../context";

/**
 * How far the device's wall clock runs ahead of the host's (ms; negative = behind), for the session's
 * `{wallMs, deviceWallMs}` anchor. The iOS simulator shares the host clock (0). Android: `date +%s%N` on the device,
 * timed against the host clock, with the round trip halved (the device read is assumed to land mid-flight).
 * Undefined when the device's clock cannot be read: the session then records no device anchor.
 */
export async function readClockOffsetMs(
	ctx: CommandContext,
	device: { platform: Platform; id: string }
): Promise<number | undefined> {
	if (device.platform === "ios") return 0;
	const before = ctx.now();
	const res = await ctx.exec([androidTools(ctx.env).adb, "-s", device.id, "shell", "date", "+%s%N"], {
		timeoutMs: 10_000,
	});
	const after = ctx.now();
	const ns = res.exitCode === 0 ? /^\d{10,}$/.exec(res.stdout.trim())?.[0] : undefined;
	if (ns === undefined) return undefined;
	const deviceMs = Math.floor(Number(ns) / 1e6);
	return Math.round(deviceMs - (before + after) / 2);
}
