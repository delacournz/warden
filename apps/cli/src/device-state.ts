import type { Exec } from "@warden/core/exec";
import { parseAllSims } from "@warden/core/golden/golden";
import { androidTools, parseAdbDevices } from "@warden/core/providers/android";
import type { Platform } from "@warden/core/types";

export type DeviceStateValue = "booted" | "shutdown";

/** Is this device running right now? iOS from `simctl list devices -j`; Android = listed by adb. undefined = unknown. */
export async function deviceState(
	exec: Exec,
	env: Record<string, string | undefined>,
	platform: Platform,
	id: string
): Promise<DeviceStateValue | undefined> {
	if (platform === "android") {
		const out = await exec([androidTools(env).adb, "devices"]);
		if (out.exitCode !== 0) return undefined;
		return parseAdbDevices(out.stdout).some((d) => d.serial === id) ? "booted" : undefined;
	}
	const out = await exec(["xcrun", "simctl", "list", "devices", "-j"]);
	if (out.exitCode !== 0) return undefined;
	const sims = parseAllSims(out.stdout);
	const sim = sims.success ? sims.data.find((s) => s.udid === id) : undefined;
	if (sim?.state === "Booted") return "booted";
	if (sim?.state === "Shutdown") return "shutdown";
	return undefined;
}
