import { execErrors } from "@delacour/warden-runtime/exec";
import { xcodeReader } from "@delacour/warden-runtime/xcode";
import { storeLocator } from "@delacour/warden-store/store";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { buildLock } from "../lock";
import { runnerCache } from "./cache";
import { runnerOutputClassifier, UNLOCK_LINE } from "./classify";
import type { EnsureRunnerBuildInput, RunnerBuild, RunnerBuildError } from "./runner-build.types";
import { signing } from "./signing";
import { runnerStage, type StagedRunner } from "./stage";

export const RUNNER_SCHEME = "WardenRunner";
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_LOCK_GRACE_MS = 45_000;

type BuildOutcome = { built: true } | { built: false; error: RunnerBuildError };

type LockedBuild = Result<RunnerBuild, RunnerBuildError>;

/** Everything `ensure` resolves before it takes the build lease. */
type RunnerBuildPlan = {
	home: string;
	team: { team: string; source: RunnerBuild["teamSource"] };
	bundleId: string;
	staged: StagedRunner;
	cacheDir: string;
	derivedData: string;
	lockKey: string;
};

/**
 * Builds and caches the on-device runner. Inputs arrive per call (callers hold different subsets of them), so callers
 * share the `runnerBuilder` instance.
 */
export class RunnerBuilder {
	/**
	 * The `xcodebuild` argv that builds the runner for one phone. `-destination id=` is what registers the UDID in the
	 * provisioning profile; the bundle id goes through `WARDEN_RUNNER_BUNDLE_ID` (the project derives the host app's,
	 * the UI-test bundle's and the runner app's ids from it, which `PRODUCT_BUNDLE_IDENTIFIER` would collapse into one).
	 */
	argv(o: { project: string; derivedData: string; udid: string; team: string; bundleId: string }): string[] {
		return [
			"xcodebuild",
			"build-for-testing",
			"-project",
			o.project,
			"-scheme",
			RUNNER_SCHEME,
			"-destination",
			`id=${o.udid}`,
			"-derivedDataPath",
			o.derivedData,
			"-allowProvisioningUpdates",
			"CODE_SIGN_STYLE=Automatic",
			`DEVELOPMENT_TEAM=${o.team}`,
			`WARDEN_RUNNER_BUNDLE_ID=${o.bundleId}`,
		];
	}

	/**
	 * The derived-data directory `ensure` would use for the current team, Xcode build and runner sources,
	 * without staging, building or taking the build lease: one Xcode version probe, the team lookup and a hash of the
	 * sources. It is the identity of a runner build; a resident host that serves another directory serves an old runner.
	 */
	async expectedDerivedData(
		input: Pick<EnsureRunnerBuildInput, "team" | "configTeamId" | "env" | "home" | "exec" | "loadSources">
	): AsyncResult<string, RunnerBuildError> {
		const home = input.home ?? storeLocator.wardenHome(input.env);
		const xcode = await xcodeReader.read(input.exec, input.env);
		if (!xcode.success) return this.failed(this.buildFailed(`no usable Xcode: ${xcode.error}`));
		const team = await signing.resolveTeam({
			explicit: input.team,
			configTeamId: input.configTeamId,
			env: input.env,
			exec: input.exec,
		});
		if (!team.success) return team;
		const loaded = await input.loadSources();
		if (!loaded.success) return this.failed(this.buildFailed(loaded.error));
		const project = "ios-runner/WardenRunner.xcodeproj/project.pbxproj";
		if (!(project in loaded.data)) return this.failed(this.buildFailed(`the iOS runner sources lack ${project}`));
		return resultFactory.ok(
			runnerCache.derivedDataDir(
				runnerCache.cacheDir(home, team.data.team, xcode.data.build, runnerStage.sourceHash(loaded.data))
			)
		);
	}

	/**
	 * A runner build signed for `udid`, ready for `xcodebuild test-without-building -xctestrun`. Cached per
	 * (team, Xcode build, runner sources) and rebuilt only for a phone the profile does not list yet, or when the
	 * profile ends within 24 h. Builds are serialised by a build lease; a waiting warden re-reads the cache and
	 * reuses what the holder built. Never installs or launches anything itself.
	 */
	async ensure(input: EnsureRunnerBuildInput): AsyncResult<RunnerBuild, RunnerBuildError> {
		const plan = await this.plan(input);
		if (!plan.success) return plan;
		const locked = await buildLock.hold(input.lock, plan.data.lockKey, () => this.buildLocked(input, plan.data));
		if (!locked.success) return this.failed(this.buildFailed(locked.error));
		return locked.data;
	}

	private failed(error: RunnerBuildError): Result<never, RunnerBuildError> {
		return { success: false, error };
	}

	private buildFailed(message: string, output = ""): RunnerBuildError {
		return {
			code: "build_failed",
			message,
			hint: "Run the same xcodebuild command by hand to see the whole output (WARDEN_DEBUG=1 prints it).",
			output,
		};
	}

	/** Xcode, signing team, bundle id and staged sources: what names the cache directory and the lease. */
	private async plan(input: EnsureRunnerBuildInput): AsyncResult<RunnerBuildPlan, RunnerBuildError> {
		const home = input.home ?? storeLocator.wardenHome(input.env);
		const xcode = await xcodeReader.read(input.exec, input.env);
		if (!xcode.success) return this.failed(this.buildFailed(`no usable Xcode: ${xcode.error}`));

		const team = await signing.resolveTeam({
			explicit: input.team,
			configTeamId: input.configTeamId,
			env: input.env,
			exec: input.exec,
		});
		if (!team.success) return team;

		const bundleId = signing.resolveBundleId(team.data.team, input.configBundleId);
		if (typeof bundleId !== "string") return this.failed(bundleId);

		const staged = await runnerStage.stage({ home, version: input.version, loadSources: input.loadSources });
		if (!staged.success) return this.failed(this.buildFailed(staged.error));

		const cacheDir = runnerCache.cacheDir(home, team.data.team, xcode.data.build, staged.data.hash);
		return resultFactory.ok({
			home,
			team: team.data,
			bundleId,
			staged: staged.data,
			cacheDir,
			derivedData: runnerCache.derivedDataDir(cacheDir),
			lockKey: buildLock.key("ios-runner", "ios", `${team.data.team}-${xcode.data.build}-${staged.data.hash}`),
		});
	}

	/** The body that runs holding the lease: reuse the cache when it serves `udid`, else build and record the meta. */
	private async buildLocked(input: EnsureRunnerBuildInput, plan: RunnerBuildPlan): AsyncResult<LockedBuild> {
		const now = input.now ?? Date.now;
		const { cacheDir, derivedData, bundleId, team } = plan;
		const xctestrun = runnerCache.findXctestrun(derivedData);
		const decision = runnerCache.decideReuse({
			meta: runnerCache.readMeta(cacheDir),
			xctestrun,
			udid: input.udid,
			bundleId,
			now: now(),
		});
		if (decision.reuse && xctestrun !== undefined) return this.done(plan, xctestrun, true);

		const because = decision.reuse ? "missing" : decision.because;
		input.log?.(`building the iPhone runner for team ${team.team} (${because}); the first build takes a few minutes`);
		const argv = this.argv({
			project: plan.staged.project,
			derivedData,
			udid: input.udid,
			team: team.team,
			bundleId,
		});
		const outcome = await this.runBuild(argv, input);
		if (!outcome.built) return resultFactory.ok<LockedBuild>(this.failed(outcome.error));
		const built = runnerCache.findXctestrun(derivedData);
		if (built === undefined) {
			return resultFactory.ok<LockedBuild>(
				this.failed(
					this.buildFailed(`xcodebuild succeeded but wrote no .xctestrun under ${derivedData}/Build/Products`)
				)
			);
		}
		const previous = runnerCache.readMeta(cacheDir);
		const sameBuild = previous !== undefined && previous.bundleId === bundleId;
		runnerCache.writeMeta(cacheDir, {
			udids: [...new Set([...(sameBuild ? previous.udids : []), input.udid])],
			profileExpires: await runnerCache.readProfileExpiry(input.exec, derivedData),
			builtAt: now(),
			bundleId,
		});
		return this.done(plan, built, false, because);
	}

	private done(
		plan: RunnerBuildPlan,
		xctestrun: string,
		cached: boolean,
		because?: RunnerBuild["rebuiltBecause"]
	): Result<LockedBuild> {
		return resultFactory.ok<LockedBuild>(
			resultFactory.ok({
				xctestrun,
				derivedData: plan.derivedData,
				bundleId: plan.bundleId,
				team: plan.team.team,
				teamSource: plan.team.source,
				cached,
				...(because !== undefined ? { rebuiltBecause: because } : {}),
			})
		);
	}

	/** Run `build-for-testing`; a phone that stays locked after the grace period stops it with `device_locked`. */
	private async runBuild(argv: string[], input: EnsureRunnerBuildInput): Promise<BuildOutcome> {
		const abort = new AbortController();
		let lockTimer: ReturnType<typeof setTimeout> | undefined;
		let lockLine: string | undefined;
		const result = await input.exec(argv, {
			env: input.env,
			timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			signal: abort.signal,
			onLine: (line) => {
				if (lockTimer !== undefined || !UNLOCK_LINE.test(line)) return;
				lockLine = line.trim();
				input.log?.(`${lockLine}: waiting for the phone to be unlocked`);
				lockTimer = setTimeout(() => abort.abort(), input.lockGraceMs ?? DEFAULT_LOCK_GRACE_MS);
			},
		});
		if (lockTimer !== undefined) clearTimeout(lockTimer);
		const output = `${result.stdout}\n${result.stderr}`;
		if (abort.signal.aborted) {
			const known = runnerOutputClassifier.classify(lockLine ?? output);
			if (known) return { built: false, error: known };
		}
		if (result.exitCode === 0) return { built: true };
		const known = runnerOutputClassifier.classify(output);
		return {
			built: false,
			error:
				known ?? this.buildFailed(execErrors.format(argv.slice(0, 2), result), runnerOutputClassifier.tail(output)),
		};
	}
}

export const runnerBuilder = new RunnerBuilder();
