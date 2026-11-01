import { join } from "node:path";
import { projectConfig } from "@delacour/warden-builds/config";
import { runnerPack } from "@delacour/warden-builds/ios-runner/pack";
import type {
	EnsureRunnerBuildInput,
	RunnerBuild,
	RunnerBuildError,
} from "@delacour/warden-builds/ios-runner/runner-build.types";
import type { BuildLockDeps } from "@delacour/warden-builds/lock";
import { ownerResolver } from "@delacour/warden-leasing/owner";
import { liveness } from "@delacour/warden-store/liveness";
import type { AsyncResult } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { type BuildInfo, buildInfoHelpers } from "../update/build-info";
import type { RunnerBuildFailure, RunnerBuildPort } from "./types";

/** `ensureRunnerBuild`, or a fake of it. */
export type EnsureRunnerBuild = (input: EnsureRunnerBuildInput) => AsyncResult<RunnerBuild, RunnerBuildError>;

export type RunnerBuildDeps = {
	ensure?: EnsureRunnerBuild;
	build?: () => BuildInfo;
	/** `ios.teamId` / `ios.runnerBundleId` of the nearest `warden.config.*` */
	iosConfig?: () => { teamId?: string; runnerBundleId?: string };
	lock?: () => BuildLockDeps;
};

export class BuildPort {
	/** A build error as the host reports it: `E_<CODE>`, the message and the one thing to do about it (teams listed when ambiguous). */
	describeBuildError(error: RunnerBuildError): RunnerBuildFailure {
		const teams = error.code === "ios_team_ambiguous" ? ` Teams: ${error.teams.map((t) => t.teamId).join(", ")}.` : "";
		return { code: `E_${error.code.toUpperCase()}`, message: `${error.message}${teams} ${error.hint}`.trim() };
	}

	private async defaultEnsure(input: EnsureRunnerBuildInput): AsyncResult<RunnerBuild, RunnerBuildError> {
		return (await import("@delacour/warden-builds/ios-runner/build")).runnerBuilder.ensure(input);
	}

	private configuredIos(ctx: CommandContext): { teamId?: string; runnerBundleId?: string } {
		const found = projectConfig.find(ctx.cwd, undefined, ctx.env);
		return found.success ? (found.data?.config.ios ?? {}) : {};
	}

	/**
	 * The runner build for `__ios-runner-host`, over `ensureRunnerBuild`: runner sources come from the embedded blob in a
	 * compiled binary and from the checkout when running from source; the team and bundle id from `warden.config.ts`
	 * (`ios.teamId`, `ios.runnerBundleId`), `WARDEN_IOS_TEAM_ID` still winning inside the build.
	 */
	createRunnerBuild(ctx: CommandContext, deps: RunnerBuildDeps = {}): RunnerBuildPort {
		return {
			ensure: async ({ udid, env }) => {
				const info = (deps.build ?? buildInfoHelpers.currentBuild.bind(buildInfoHelpers))();
				const ios = (deps.iosConfig ?? (() => this.configuredIos(ctx)))();
				const lock: BuildLockDeps = (deps.lock ?? (() => this.defaultLock(ctx)))();
				const built = await (deps.ensure ?? this.defaultEnsure.bind(this))({
					udid,
					env: { ...env },
					exec: ctx.exec,
					version: info.version,
					configTeamId: ios.teamId,
					configBundleId: ios.runnerBundleId,
					lock,
					log: (line) => ctx.err(line),
					loadSources: async () =>
						info.channel === "dev"
							? runnerPack.collect(join(info.sourceDir, "packages", "e2e", "native"))
							: runnerPack.loadEmbedded(),
				});
				if (!built.success) return { success: false, error: this.describeBuildError(built.error) };
				const { xctestrun, derivedData, bundleId } = built.data;
				return { success: true, data: { xctestrun, derivedData, bundleId } };
			},
		};
	}

	private defaultLock(ctx: CommandContext): BuildLockDeps {
		return {
			store: ctx.store(),
			owner: ownerResolver.resolve(ctx),
			pid: process.pid,
			now: Date.now,
			pidAlive: liveness.processAlive,
			sleep: (ms) => Bun.sleep(ms),
			log: (line) => ctx.err(line),
		};
	}
}

export const buildPort = new BuildPort();
