import type { AsyncResult } from "@delacour/warden-types/result";

/** What the runner build step hands back: the `.xctestrun` to run, its derived data, and the runner's bundle id. */
export type RunnerArtifacts = { xctestrun: string; derivedData: string; bundleId: string };

/** Why the runner could not be built or found (`ensureRunnerBuild`'s error, reduced to what the host reports). */
export type RunnerBuildFailure = { code: string; message: string };

/**
 * The one thing `__ios-runner-host` needs from the build cache (WDN-PHY-4's `ensureRunnerBuild`): the signed runner
 * for this device, built if absent. Injected so the host never imports the builder.
 */
export type RunnerBuildPort = {
	ensure(input: {
		udid: string;
		env: Readonly<Record<string, string | undefined>>;
	}): AsyncResult<RunnerArtifacts, RunnerBuildFailure>;
};

/** Why the runner is not (or no longer) serving: every code is something a caller can act on. */
export type RunnerFault =
	| { kind: "device_locked"; message: string }
	| { kind: "developer_mode_off"; message: string }
	| { kind: "runner_untrusted"; message: string }
	| { kind: "device_busy"; message: string }
	| { kind: "install_failed"; message: string }
	| { kind: "tunnel_down"; message: string }
	| { kind: "runner_failed"; message: string }
	| { kind: "ready_timeout"; message: string }
	| { kind: "xcodebuild_exited"; exitCode: number | null; message: string };

export type RunnerFaultKind = RunnerFault["kind"];

/** A running `xcodebuild`: its output, its exit, and a way to stop it. */
export type RunnerProcess = {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
};

/** Starts `cmd` with `env` on top of the host's own. Tests replace it with a fake that emits fixture lines. */
export type SpawnRunner = (cmd: readonly string[], env: Readonly<Record<string, string>>) => RunnerProcess;

/** Where the runner listens, as the Mac reaches it. */
export type RunnerAddress = { host: string; port: number };
