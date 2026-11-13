import { findWardenConfig } from "@delacour/warden-core/builds/config";
import type { BuildLockDeps } from "@delacour/warden-core/builds/lock";
import type {
	EnsureRunnerBuildInput,
	RunnerBuild,
	RunnerBuildError,
} from "@delacour/warden-core/ios-runner/runner-build.types";
import { processAlive } from "@delacour/warden-core/liveness";
import type { AsyncResult } from "@delacour/warden-types/result";
import { resolveOwner } from "../claim-flags";
import type { CommandContext } from "../context";
import { type BuildInfo, currentBuild } from "../update/build-info";
import { runnerSourcesFor } from "./sim-sources";
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

/** A build error as the host reports it: `E_<CODE>`, the message and the one thing to do about it (teams listed when ambiguous). */
export function describeBuildError(error: RunnerBuildError): RunnerBuildFailure {
	const teams = error.code === "ios_team_ambiguous" ? ` Teams: ${error.teams.map((t) => t.teamId).join(", ")}.` : "";
	return { code: `E_${error.code.toUpperCase()}`, message: `${error.message}${teams} ${error.hint}`.trim() };
}

async function defaultEnsure(input: EnsureRunnerBuildInput): AsyncResult<RunnerBuild, RunnerBuildError> {
	return (await import("@delacour/warden-core/ios-runner/build")).ensureRunnerBuild(input);
}

function configuredIos(ctx: CommandContext): { teamId?: string; runnerBundleId?: string } {
	const found = findWardenConfig(ctx.cwd, undefined, ctx.env);
	return found.success ? (found.data?.config.ios ?? {}) : {};
}

/**
 * The runner build for `__ios-runner-host`, over `ensureRunnerBuild`: runner sources come from the embedded blob in a
 * compiled binary and from the checkout when running from source; the team and bundle id from `warden.config.ts`
 * (`ios.teamId`, `ios.runnerBundleId`), `WARDEN_IOS_TEAM_ID` still winning inside the build.
 */
export function createRunnerBuild(ctx: CommandContext, deps: RunnerBuildDeps = {}): RunnerBuildPort {
	return {
		ensure: async ({ udid, env }) => {
			const info = (deps.build ?? currentBuild)();
			const ios = (deps.iosConfig ?? (() => configuredIos(ctx)))();
			const lock: BuildLockDeps = (deps.lock ?? (() => defaultLock(ctx)))();
			const built = await (deps.ensure ?? defaultEnsure)({
				udid,
				env: { ...env },
				exec: ctx.exec,
				version: info.version,
				configTeamId: ios.teamId,
				configBundleId: ios.runnerBundleId,
				lock,
				log: (line) => ctx.err(line),
				loadSources: runnerSourcesFor(info),
			});
			if (!built.success) return { success: false, error: describeBuildError(built.error) };
			const { xctestrun, derivedData, bundleId } = built.data;
			return { success: true, data: { xctestrun, derivedData, bundleId } };
		},
	};
}

function defaultLock(ctx: CommandContext): BuildLockDeps {
	return {
		store: ctx.store(),
		owner: resolveOwner(ctx),
		pid: process.pid,
		now: Date.now,
		pidAlive: processAlive,
		sleep: (ms) => Bun.sleep(ms),
		log: (line) => ctx.err(line),
	};
}
