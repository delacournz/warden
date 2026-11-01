import { type PerfAppRef, perfApp } from "@delacour/warden-sdk/ops/perf/app";
import type { Platform } from "@delacour/warden-store/types";
import type { Result } from "@delacour/warden-types/result";
import type { UiError } from "../agent-ui/output";
import type { CommandContext } from "../context";

export type { PerfAppRef };

type DeviceRef = { platform: Platform; id: string };

export class PerfAppCli {
	/** The app in the foreground (iOS: the one running non-system app), or undefined. */
	foregroundApp(ctx: CommandContext, device: DeviceRef): Promise<string | undefined> {
		return perfApp.foregroundApp(ctx, device);
	}

	/** The bundle id / package `warden.config.ts` (or the app config) names for this platform. */
	private async configApp(ctx: CommandContext, platform: Platform): Promise<string | undefined> {
		const { projectContextHelpers } = await import("../project-context");
		const { projectConfig } = await import("@delacour/warden-builds/config");
		const project = await projectContextHelpers.projectContextFor(ctx, { start: ctx.cwd, variantOptional: true });
		if (!project.success) return undefined;
		const id = projectConfig.bundleIdFor(project.data.project, platform);
		return id.success ? id.data : undefined;
	}

	/** The app to profile: `--app`, then the foreground app, then the warden config's app. */
	resolveApp(ctx: CommandContext, device: DeviceRef, flag: string | undefined): Promise<Result<PerfAppRef, UiError>> {
		return perfApp.resolveAppWith(ctx, device, flag, (platform) => this.configApp(ctx, platform));
	}
}

export const perfAppCli = new PerfAppCli();
