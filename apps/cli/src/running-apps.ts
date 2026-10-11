import type { Exec } from "@delacour/warden-core/exec";
import type { Platform } from "@delacour/warden-core/types";

/** Bundle ids of running apps in `launchctl list` output (`<pid> <status> UIKitApplication:<id>[…]`). */
export function parseLaunchdApps(output: string): string[] {
	return output.split("\n").flatMap((line) => {
		const m = /^\s*(\d+)\s+\S+\s+UIKitApplication:([^\s[]+)/.exec(line);
		return m?.[2] ? [m[2]] : [];
	});
}

/**
 * Is an app running on the device? Leases carry no bundle id, so the rule is conservative: any
 * running UIKitApplication that isn't an Apple system app (`com.apple.*`) counts. iOS only
 * (`simctl spawn <udid> launchctl list`); Android relies on the grace period alone. A failed probe
 * reads as "no app" — it must never wedge gc.
 */
export async function hasForegroundApp(exec: Exec, platform: Platform, udid: string): Promise<boolean> {
	if (platform !== "ios") return false;
	const result = await exec(["xcrun", "simctl", "spawn", udid, "launchctl", "list"], { timeoutMs: 10_000 });
	if (result.exitCode !== 0) return false;
	return parseLaunchdApps(result.stdout).some((id) => !id.startsWith("com.apple."));
}
