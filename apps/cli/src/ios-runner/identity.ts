import { join } from "node:path";
import { findWardenConfig } from "@delacour/warden-core/builds/config";
import { collectRunnerSources, loadEmbeddedRunnerSources } from "@delacour/warden-core/ios-runner/pack";
import type { EnsureRunnerBuildInput, RunnerBuildError } from "@delacour/warden-core/ios-runner/runner-build.types";
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
			const found = findWardenConfig(ctx.cwd, undefined, ctx.env);
			return found.success ? (found.data?.config.ios ?? {}) : {};
		})();
	const run = deps.expected ?? (await import("@delacour/warden-core/ios-runner/build")).expectedRunnerDerivedData;
	const res = await run({
		configTeamId: ios.teamId,
		env: { ...ctx.env },
		exec: ctx.exec,
		loadSources: async () =>
			info.channel === "dev"
				? collectRunnerSources(join(info.sourceDir, "packages", "e2e", "native"))
				: loadEmbeddedRunnerSources(),
	});
	return res.success ? res.data : undefined;
}
