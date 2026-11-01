import { join } from "node:path";
import { projectConfig } from "@delacour/warden-builds/config";
import { runnerPack } from "@delacour/warden-builds/ios-runner/pack";
import type { EnsureRunnerBuildInput, RunnerBuildError } from "@delacour/warden-builds/ios-runner/runner-build.types";
import type { AsyncResult } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { type BuildInfo, currentBuild } from "../update/build-info";

type ExpectedInput = Pick<EnsureRunnerBuildInput, "team" | "configTeamId" | "env" | "home" | "exec" | "loadSources">;

export type ExpectedIdentityDeps = {
	expected?: (input: ExpectedInput) => AsyncResult<string, RunnerBuildError>;
	build?: () => BuildInfo;
	iosConfig?: () => { teamId?: string; runnerBundleId?: string };
};

/**
 * The derived data the runner would be built into now (same team, Xcode build and runner sources `createRunnerBuild`
 * uses), or undefined when that cannot be told (no team, no Xcode): then the host is left alone and its own start
 * reports the problem. Cheap: no staging, no lock, no xcodebuild.
 */
export async function expectedRunnerIdentity(
	ctx: Pick<CommandContext, "cwd" | "env" | "exec">,
	deps: ExpectedIdentityDeps = {}
): Promise<string | undefined> {
	const info = (deps.build ?? currentBuild)();
	const ios =
		deps.iosConfig?.() ??
		(() => {
			const found = projectConfig.find(ctx.cwd, undefined, ctx.env);
			return found.success ? (found.data?.config.ios ?? {}) : {};
		})();
	const run =
		deps.expected ??
		(async (input: ExpectedInput) =>
			(await import("@delacour/warden-builds/ios-runner/build")).runnerBuilder.expectedDerivedData(input));
	const res = await run({
		configTeamId: ios.teamId,
		env: { ...ctx.env },
		exec: ctx.exec,
		loadSources: async () =>
			info.channel === "dev"
				? runnerPack.collect(join(info.sourceDir, "packages", "e2e", "native"))
				: runnerPack.loadEmbedded(),
	});
	return res.success ? res.data : undefined;
}
