import { androidTools } from "@delacour/warden-core/providers/android";
import type { Platform } from "@delacour/warden-core/types";
import { parseIosRunningApps, parseResumedActivity, pickIosApp } from "@delacour/warden-perf/shared/app-detect";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";

export type PerfAppRef = { id: string; source: "flag" | "foreground" | "config" };

type DeviceRef = { platform: Platform; id: string };

/** `simctl spawn <udid> launchctl list` (iOS) or `dumpsys activity activities` (Android) on the device. */
function listArgv(ctx: CommandContext, device: DeviceRef): string[] {
	return device.platform === "ios"
		? ["xcrun", "simctl", "spawn", device.id, "launchctl", "list"]
		: [androidTools(ctx.env).adb, "-s", device.id, "shell", "dumpsys", "activity", "activities"];
}

type Detected = { kind: "app"; id: string } | { kind: "ambiguous"; candidates: string[] } | { kind: "none" };

async function detect(ctx: CommandContext, device: DeviceRef): Promise<Detected> {
	const res = await ctx.exec(listArgv(ctx, device), { timeoutMs: 10_000 });
	if (res.exitCode !== 0) return { kind: "none" };
	if (device.platform === "android") {
		const resumed = parseResumedActivity(res.stdout);
		return resumed ? { kind: "app", id: resumed.package } : { kind: "none" };
	}
	const pick = pickIosApp(parseIosRunningApps(res.stdout));
	if (pick.kind === "app") return { kind: "app", id: pick.bundleId };
	return pick;
}

/** The app in the foreground (iOS: the one running non-system app), or undefined. */
export async function foregroundApp(ctx: CommandContext, device: DeviceRef): Promise<string | undefined> {
	const found = await detect(ctx, device);
	return found.kind === "app" ? found.id : undefined;
}

/** The bundle id / package `warden.config.ts` (or the app config) names for this platform. */
async function configApp(ctx: CommandContext, platform: Platform): Promise<string | undefined> {
	const { projectContextFor } = await import("../project-context");
	const { bundleIdFor } = await import("@delacour/warden-core/builds/config");
	const project = await projectContextFor(ctx, { start: ctx.cwd, variantOptional: true });
	if (!project.success) return undefined;
	const id = bundleIdFor(project.data.project, platform);
	return id.success ? id.data : undefined;
}

/** The app to profile: `--app`, then the foreground app, then the warden config's app. */
export async function resolveApp(
	ctx: CommandContext,
	device: DeviceRef,
	flag: string | undefined
): Promise<Result<PerfAppRef, UiError>> {
	if (flag !== undefined && flag !== "") return ok({ id: flag, source: "flag" });
	const found = await detect(ctx, device);
	if (found.kind === "app") return ok({ id: found.id, source: "foreground" });
	if (found.kind === "none") {
		const configured = await configApp(ctx, device.platform);
		if (configured !== undefined) return ok({ id: configured, source: "config" });
	}
	const message =
		found.kind === "ambiguous"
			? `several apps are running: ${found.candidates.join(", ")}`
			: `no app detected on ${device.id}`;
	return {
		success: false,
		error: uiError("app_not_found", message, { hint: "pass --app <bundleId|package>" }),
	};
}
