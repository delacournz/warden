import { type AsyncResult, ok, type Result } from "@delacour/warden-types/result";
import { buildLockKey, withBuildLock } from "../builds/lock";
import { execError } from "../exec";
import { wardenHome } from "../store";
import { readXcode } from "../xcode";
import {
	decideReuse,
	derivedDataDir,
	findXctestrun,
	readProfileExpiry,
	readRunnerMeta,
	runnerCacheDir,
	writeRunnerMeta,
} from "./cache";
import { classifyRunnerOutput, outputTail, UNLOCK_LINE } from "./classify";
import type { EnsureRunnerBuildInput, RunnerBuild, RunnerBuildError } from "./runner-build.types";
import { resolveRunnerBundleId, resolveTeam } from "./signing";
import { runnerSourceHash, stageRunnerSources } from "./stage";

export const RUNNER_SCHEME = "WardenRunner";
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_LOCK_GRACE_MS = 45_000;

function failed(error: RunnerBuildError): Result<never, RunnerBuildError> {
	return { success: false, error };
}

function buildFailed(message: string, output = ""): RunnerBuildError {
	return {
		code: "build_failed",
		message,
		hint: "Run the same xcodebuild command by hand to see the whole output (WARDEN_DEBUG=1 prints it).",
		output,
	};
}

/**
 * The `xcodebuild` argv that builds the runner for one phone. `-destination id=` is what registers the UDID in the
 * provisioning profile; the bundle id goes through `WARDEN_RUNNER_BUNDLE_ID` (the project derives the host app's,
 * the UI-test bundle's and the runner app's ids from it, which `PRODUCT_BUNDLE_IDENTIFIER` would collapse into one).
 */
export function buildRunnerArgv(o: {
	project: string;
	derivedData: string;
	udid: string;
	team: string;
	bundleId: string;
}): string[] {
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

type BuildOutcome = { built: true } | { built: false; error: RunnerBuildError };

/** Run `build-for-testing`; a phone that stays locked after the grace period stops it with `device_locked`. */
async function runBuild(argv: string[], input: EnsureRunnerBuildInput): Promise<BuildOutcome> {
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
		const known = classifyRunnerOutput(lockLine ?? output);
		if (known) return { built: false, error: known };
	}
	if (result.exitCode === 0) return { built: true };
	const known = classifyRunnerOutput(output);
	return {
		built: false,
		error: known ?? buildFailed(execError(argv.slice(0, 2), result), outputTail(output)),
	};
}

/**
 * The derived-data directory `ensureRunnerBuild` would use for the current team, Xcode build and runner sources,
 * without staging, building or taking the build lease: one Xcode version probe, the team lookup and a hash of the
 * sources. It is the identity of a runner build; a resident host that serves another directory serves an old runner.
 */
export async function expectedRunnerDerivedData(
	input: Pick<EnsureRunnerBuildInput, "team" | "configTeamId" | "env" | "home" | "exec" | "loadSources">
): AsyncResult<string, RunnerBuildError> {
	const home = input.home ?? wardenHome(input.env);
	const xcode = await readXcode(input.exec, input.env);
	if (!xcode.success) return failed(buildFailed(`no usable Xcode: ${xcode.error}`));
	const team = await resolveTeam({
		explicit: input.team,
		configTeamId: input.configTeamId,
		env: input.env,
		exec: input.exec,
	});
	if (!team.success) return team;
	const loaded = await input.loadSources();
	if (!loaded.success) return failed(buildFailed(loaded.error));
	const project = "ios-runner/WardenRunner.xcodeproj/project.pbxproj";
	if (!(project in loaded.data)) return failed(buildFailed(`the iOS runner sources lack ${project}`));
	return ok(derivedDataDir(runnerCacheDir(home, team.data.team, xcode.data.build, runnerSourceHash(loaded.data))));
}

/**
 * A runner build signed for `udid`, ready for `xcodebuild test-without-building -xctestrun`. Cached per
 * (team, Xcode build, runner sources) and rebuilt only for a phone the profile does not list yet, or when the
 * profile ends within 24 h. Builds are serialised by a build lease; a waiting warden re-reads the cache and
 * reuses what the holder built. Never installs or launches anything itself.
 */
export async function ensureRunnerBuild(input: EnsureRunnerBuildInput): AsyncResult<RunnerBuild, RunnerBuildError> {
	const now = input.now ?? Date.now;
	const home = input.home ?? wardenHome(input.env);
	const xcode = await readXcode(input.exec, input.env);
	if (!xcode.success) return failed(buildFailed(`no usable Xcode: ${xcode.error}`));

	const team = await resolveTeam({
		explicit: input.team,
		configTeamId: input.configTeamId,
		env: input.env,
		exec: input.exec,
	});
	if (!team.success) return team;

	const bundleId = resolveRunnerBundleId(team.data.team, input.configBundleId);
	if (typeof bundleId !== "string") return failed(bundleId);

	const staged = await stageRunnerSources({ home, version: input.version, loadSources: input.loadSources });
	if (!staged.success) return failed(buildFailed(staged.error));

	const cacheDir = runnerCacheDir(home, team.data.team, xcode.data.build, staged.data.hash);
	const derivedData = derivedDataDir(cacheDir);
	const lockKey = buildLockKey("ios-runner", "ios", `${team.data.team}-${xcode.data.build}-${staged.data.hash}`);

	const locked = await withBuildLock(input.lock, lockKey, async () => {
		const check = () => {
			const xctestrun = findXctestrun(derivedData);
			return {
				xctestrun,
				decision: decideReuse({ meta: readRunnerMeta(cacheDir), xctestrun, udid: input.udid, bundleId, now: now() }),
			};
		};
		const first = check();
		const done = (xctestrun: string, cached: boolean, because?: RunnerBuild["rebuiltBecause"]) =>
			ok<Result<RunnerBuild, RunnerBuildError>>(
				ok({
					xctestrun,
					derivedData,
					bundleId,
					team: team.data.team,
					teamSource: team.data.source,
					cached,
					...(because !== undefined ? { rebuiltBecause: because } : {}),
				})
			);
		if (first.decision.reuse && first.xctestrun !== undefined) return done(first.xctestrun, true);

		const because = first.decision.reuse ? "missing" : first.decision.because;
		input.log?.(
			`building the iPhone runner for team ${team.data.team} (${because}); the first build takes a few minutes`
		);
		const argv = buildRunnerArgv({
			project: staged.data.project,
			derivedData,
			udid: input.udid,
			team: team.data.team,
			bundleId,
		});
		const outcome = await runBuild(argv, input);
		if (!outcome.built) return ok<Result<RunnerBuild, RunnerBuildError>>(failed(outcome.error));
		const xctestrun = findXctestrun(derivedData);
		if (xctestrun === undefined) {
			return ok<Result<RunnerBuild, RunnerBuildError>>(
				failed(buildFailed(`xcodebuild succeeded but wrote no .xctestrun under ${derivedData}/Build/Products`))
			);
		}
		const previous = readRunnerMeta(cacheDir);
		const sameBuild = previous !== undefined && previous.bundleId === bundleId;
		writeRunnerMeta(cacheDir, {
			udids: [...new Set([...(sameBuild ? previous.udids : []), input.udid])],
			profileExpires: await readProfileExpiry(input.exec, derivedData),
			builtAt: now(),
			bundleId,
		});
		return done(xctestrun, false, because);
	});
	if (!locked.success) return failed(buildFailed(locked.error));
	return locked.data;
}
