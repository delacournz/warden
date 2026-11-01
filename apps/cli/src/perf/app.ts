import { foregroundApp as detectForeground, type PerfAppRef, resolveAppWith } from "@delacour/warden-sdk/ops/perf/app";
import type { Platform } from "@delacour/warden-store/types";
import type { Result } from "@delacour/warden-types/result";
import type { UiError } from "../agent-ui/output";
import type { CommandContext } from "../context";

export type { PerfAppRef };

type DeviceRef = { platform: Platform; id: string };

/** The app in the foreground (iOS: the one running non-system app), or undefined. */
export function foregroundApp(ctx: CommandContext, device: DeviceRef): Promise<string | undefined> {
	return detectForeground(ctx, device);
}

/** The bundle id / package `warden.config.ts` (or the app config) names for this platform. */
async function configApp(ctx: CommandContext, platform: Platform): Promise<string | undefined> {
	const { projectContextFor } = await import("../project-context");
	const { bundleIdFor } = await import("@delacour/warden-builds/config");
	const project = await projectContextFor(ctx, { start: ctx.cwd, variantOptional: true });
	if (!project.success) return undefined;
	const id = bundleIdFor(project.data.project, platform);
	return id.success ? id.data : undefined;
}

/** The app to profile: `--app`, then the foreground app, then the warden config's app. */
export function resolveApp(
	ctx: CommandContext,
	device: DeviceRef,
	flag: string | undefined
): Promise<Result<PerfAppRef, UiError>> {
	return resolveAppWith(ctx, device, flag, (platform) => configApp(ctx, platform));
}
