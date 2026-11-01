import { appDetector } from "@delacour/warden-perf/shared/app-detect";
import { androidToolsLocator } from "@delacour/warden-providers/android-tools";
import type { Platform } from "@delacour/warden-store/types";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { opErrors } from "../errors";
import type { PerfEnv } from "./env";

export type PerfAppRef = { id: string; source: "flag" | "foreground" | "config" };

type DeviceRef = { platform: Platform; id: string };

type Detected = { kind: "app"; id: string } | { kind: "ambiguous"; candidates: string[] } | { kind: "none" };

/** Where the project's configured app is read from (the CLI: `warden.config.ts`); absent in the SDK, whose sessions know their app. */
export type ConfigApp = (platform: Platform) => Promise<string | undefined>;

/** PerfApp: app. */
export class PerfApp {
	/** `simctl spawn <udid> launchctl list` (iOS) or `dumpsys activity activities` (Android) on the device. */
	private listArgv(ctx: PerfEnv, device: DeviceRef): string[] {
		return device.platform === "ios"
			? ["xcrun", "simctl", "spawn", device.id, "launchctl", "list"]
			: [androidToolsLocator.locate(ctx.env).adb, "-s", device.id, "shell", "dumpsys", "activity", "activities"];
	}

	private async detect(ctx: PerfEnv, device: DeviceRef): Promise<Detected> {
		const res = await ctx.exec(this.listArgv(ctx, device), { timeoutMs: 10_000 });
		if (res.exitCode !== 0) return { kind: "none" };
		if (device.platform === "android") {
			const resumed = appDetector.parseResumedActivity(res.stdout);
			return resumed ? { kind: "app", id: resumed.package } : { kind: "none" };
		}
		const pick = appDetector.pickIosApp(appDetector.parseIosRunningApps(res.stdout));
		if (pick.kind === "app") return { kind: "app", id: pick.bundleId };
		return pick;
	}

	/** The app in the foreground (iOS: the one running non-system app), or undefined. */
	async foregroundApp(ctx: PerfEnv, device: DeviceRef): Promise<string | undefined> {
		const found = await this.detect(ctx, device);
		return found.kind === "app" ? found.id : undefined;
	}

	/** The app to profile: the flag, then the foreground app, then the configured app (when `configApp` is given). */
	async resolveAppWith(
		ctx: PerfEnv,
		device: DeviceRef,
		flag: string | undefined,
		configApp?: ConfigApp
	): Promise<Result<PerfAppRef, WardenError>> {
		if (flag !== undefined && flag !== "") return resultFactory.ok({ id: flag, source: "flag" });
		const found = await this.detect(ctx, device);
		if (found.kind === "app") return resultFactory.ok({ id: found.id, source: "foreground" });
		if (found.kind === "none" && configApp !== undefined) {
			const configured = await configApp(device.platform);
			if (configured !== undefined) return resultFactory.ok({ id: configured, source: "config" });
		}
		const message =
			found.kind === "ambiguous"
				? `several apps are running: ${found.candidates.join(", ")}`
				: `no app detected on ${device.id}`;
		return {
			success: false,
			error: opErrors.opError("app_not_found", message, { hint: "pass --app <bundleId|package>" }),
		};
	}
}

export const perfApp = new PerfApp();
