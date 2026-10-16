import type { Suite } from "@delacour/warden-core/affected/affected";
import { appSwitches } from "@delacour/warden-core/builds/app-option.schema";
import { bundleIdFor } from "@delacour/warden-core/builds/config";
import type { Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { devClientLaunchArgs } from "../metro";
import { projectContextFor } from "../project-context";

/** What decides how a spec's app is launched, known before any device is leased. */
export type LaunchPlan = {
	/** `metro.launchArgs` (empty without Metro) */
	metroLaunchArgs: readonly string[];
	/** `spec.launchArgs` */
	launchArgs: readonly string[];
};

/**
 * The app the specs drive: `spec.bundleId`, else the suite project's bundle id for the platform
 * (the project is found from the suite's project root, as for Metro).
 */
export async function specBundleId(ctx: CommandContext, suite: Suite, platform: Platform): AsyncResult<string> {
	const explicit = suite.config.spec?.bundleId;
	if (explicit !== undefined) return ok(explicit);
	const { variant } = appSwitches(suite.config.app);
	const project = await projectContextFor(ctx, {
		start: suite.projectRoot ?? suite.cwd,
		...(variant !== undefined ? { variant, variantOptional: true } : {}),
	});
	const bundleId = project.success ? bundleIdFor(project.data.project, platform) : undefined;
	if (bundleId?.success) return bundleId;
	return err(`e2e.${suite.name}: no bundle id — set spec.bundleId or projects[].bundleId.${platform}`);
}

/**
 * `WARDEN_LAUNCH_ARGS`: what `app.open()` passes the app. With Metro (`metroUrl` known once it is
 * up) `--initialUrl <metroUrl>` comes first, then `metro.launchArgs`, then `spec.launchArgs`.
 */
export function specLaunchArgs(plan: LaunchPlan, metroUrl: string | undefined): string[] {
	const extra = [...plan.metroLaunchArgs, ...plan.launchArgs];
	return metroUrl === undefined ? extra : devClientLaunchArgs(metroUrl, extra);
}
