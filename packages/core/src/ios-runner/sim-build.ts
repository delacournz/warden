import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { type BuildLockDeps, buildLockKey, withBuildLock } from "../builds/lock";
import { type Exec, execError } from "../exec";
import { wardenHome } from "../store";
import { readXcode } from "../xcode";
import { formatBuildIssues, prepareResultBundle, readBuildIssues } from "../xcresult";
import { RUNNER_SCHEME } from "./build";
import { derivedDataDir, findXctestrun } from "./cache";
import { outputTail } from "./classify";
import type { RunnerSourceFiles } from "./runner-build.types";
import { runnerRoot, stageRunnerSources } from "./stage";

/**
 * The runner (XCUITest server) built for the iOS Simulator: no signing, no team, no device registration, so it is one
 * `xcodebuild build-for-testing -destination 'generic/platform=iOS Simulator'` (about 4-10 s) per Xcode build and runner
 * source hash, cached under `<home>/ios-runner/simulator/<xcodeBuild>-<hash>`. Any simulator can then run it
 * (`test-without-building -destination id=<udid>`). Used by the XCUITest accessibility audit (A11Y-4).
 */

export type SimRunnerBuild = {
	/** the `.xctestrun` inside `derivedData` */
	xctestrun: string;
	derivedData: string;
	/** false: built just now */
	cached: boolean;
};

export type EnsureSimRunnerInput = {
	env: Record<string, string | undefined>;
	exec: Exec;
	/** warden's own version (part of the staged-source directory name) */
	version: string;
	loadSources: () => AsyncResult<RunnerSourceFiles>;
	/** serialises builds of one (Xcode, sources); without it two concurrent callers may both build */
	lock?: BuildLockDeps;
	home?: string;
	log?: (line: string) => void;
	timeoutMs?: number;
};

const BUILT_MARKER = "built.ok";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export function simRunnerCacheDir(home: string, xcodeBuild: string, srcHash: string): string {
	return join(runnerRoot(home), "simulator", `${xcodeBuild}-${srcHash}`);
}

export function buildSimRunnerArgv(o: { project: string; derivedData: string; resultBundle?: string }): string[] {
	return [
		"xcodebuild",
		"build-for-testing",
		"-project",
		o.project,
		"-scheme",
		RUNNER_SCHEME,
		"-destination",
		"generic/platform=iOS Simulator",
		"-derivedDataPath",
		o.derivedData,
		"CODE_SIGNING_ALLOWED=NO",
		"DEVELOPMENT_TEAM=",
		...(o.resultBundle === undefined ? [] : ["-resultBundlePath", o.resultBundle]),
	];
}

/** A simulator runner build for the current Xcode and runner sources; built now when the cache has none. */
export async function ensureSimRunnerBuild(input: EnsureSimRunnerInput): AsyncResult<SimRunnerBuild> {
	const home = input.home ?? wardenHome(input.env);
	const xcode = await readXcode(input.exec, input.env);
	if (!xcode.success) return err(`no usable Xcode: ${xcode.error}`);
	const staged = await stageRunnerSources({ home, version: input.version, loadSources: input.loadSources });
	if (!staged.success) return staged;
	const cacheDir = simRunnerCacheDir(home, xcode.data.build, staged.data.hash);
	const derivedData = derivedDataDir(cacheDir);
	const cached = (): SimRunnerBuild | undefined => {
		const xctestrun = existsSync(join(cacheDir, BUILT_MARKER)) ? findXctestrun(derivedData) : undefined;
		return xctestrun === undefined ? undefined : { xctestrun, derivedData, cached: true };
	};
	const hit = cached();
	if (hit !== undefined) return ok(hit);

	const build = async (): AsyncResult<SimRunnerBuild> => {
		const again = cached();
		if (again !== undefined) return ok(again);
		input.log?.("building the iOS Simulator runner (first use of this Xcode / runner version)");
		const resultBundle = prepareResultBundle(join(cacheDir, "results"), "build");
		const argv = buildSimRunnerArgv({ project: staged.data.project, derivedData, resultBundle });
		const result = await input.exec(argv, { env: input.env, timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS });
		if (result.exitCode !== 0) {
			const issues = await readBuildIssues(resultBundle, input.exec);
			const summary = issues === null ? undefined : formatBuildIssues(issues);
			const why =
				summary === undefined
					? `${execError(argv.slice(0, 2), result)}: ${outputTail(`${result.stdout}\n${result.stderr}`)}`
					: `\`${argv.slice(0, 2).join(" ")}\` exited ${result.exitCode}: ${summary}`;
			return err(`${why} (result bundle: ${resultBundle})`);
		}
		const xctestrun = findXctestrun(derivedData);
		if (xctestrun === undefined)
			return err(`xcodebuild succeeded but wrote no .xctestrun under ${derivedData}/Build/Products`);
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(join(cacheDir, BUILT_MARKER), `${Date.now()}\n`);
		return ok({ xctestrun, derivedData, cached: false });
	};
	if (input.lock === undefined) return build();
	return withBuildLock(
		input.lock,
		buildLockKey("ios-runner", "ios", `simulator-${xcode.data.build}-${staged.data.hash}`),
		build
	);
}
