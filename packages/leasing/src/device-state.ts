import { adbParser } from "@delacour/warden-providers/android";
import { androidToolsLocator } from "@delacour/warden-providers/android-tools";
import { simctlListParser } from "@delacour/warden-providers/simctl-list";
import type { Exec } from "@delacour/warden-runtime/exec";
import type { Platform } from "@delacour/warden-store/types";

export type DeviceStateValue = "booted" | "shutdown";

export type DeviceStateDeps = { exec: Exec; env: Record<string, string | undefined> };

export class DeviceStateProbe {
	constructor(private readonly deps: DeviceStateDeps) {}

	/** Is this device running right now? iOS from `simctl list devices -j`; Android = listed by adb. undefined = unknown. */
	async state(platform: Platform, id: string): Promise<DeviceStateValue | undefined> {
		const { exec, env } = this.deps;
		if (platform === "android") {
			const out = await exec([androidToolsLocator.locate(env).adb, "devices"]);
			if (out.exitCode !== 0) return undefined;
			return adbParser.parseEmulators(out.stdout).some((d) => d.serial === id) ? "booted" : undefined;
		}
		const out = await exec(["xcrun", "simctl", "list", "devices", "-j"]);
		if (out.exitCode !== 0) return undefined;
		const sims = simctlListParser.parseAll(out.stdout);
		const sim = sims.success ? sims.data.find((s) => s.udid === id) : undefined;
		if (sim?.state === "Booted") return "booted";
		if (sim?.state === "Shutdown") return "shutdown";
		return undefined;
	}
}
