import type { AsyncResult } from "@delacour/warden-types/result";
import { type RouteDeps, readTunnelIp, waitTunnelConnected } from "./route";
import type { RunnerAddress, RunnerArtifacts, RunnerFault, RunnerProcess, SpawnRunner } from "./types";

/**
 * One `xcodebuild test-without-building ... testServe` run: the process that keeps the runner alive on the phone.
 * It classifies what `xcodebuild` prints (a locked phone makes it block forever on "Unlock … to Continue"), retries
 * the install once on `IXRemoteErrorDomain` 6 (a tunnel that was not up yet), and re-reads the tunnel address after
 * the install because it changes every time the runner is reinstalled.
 */

export const READY_PREFIX = "WARDEN_RUNNER_READY";
export const FAILED_PREFIX = "WARDEN_RUNNER_FAILED";
export const TEST_FILTER = "-only-testing:WardenRunnerUITests/RunnerTests/testServe";

/** the runner is up ~15-30 s after `xcodebuild` starts; a first install on a fresh phone is slower */
export const READY_TIMEOUT_MS = 120_000;
const STOP_WAIT_MS = 5000;
const TAIL_LINES = 8;

export type SessionDeps = {
	spawn: SpawnRunner;
	route: RouteDeps;
	/** run `fn` after `ms`; the returned function cancels it */
	after: (ms: number, fn: () => void) => () => void;
	log: (line: string) => void;
	readyTimeoutMs?: number;
	tunnelWaitMs?: number;
};

export type SessionInput = {
	udid: string;
	artifacts: RunnerArtifacts;
	/** the runner exits by itself after this long with no request (0 = never) */
	runnerIdleSeconds: number;
};

/** How a running session ended: asked to stop (or the runner shut down cleanly), or died. */
export type SessionEnd = { kind: "clean" } | { kind: "fault"; fault: RunnerFault };

export type Session = {
	address: RunnerAddress;
	/** settles once, when `xcodebuild` exits */
	ended: Promise<SessionEnd>;
	/** SIGTERM `xcodebuild` (SIGKILL after 5 s) and wait for it */
	stop(): Promise<void>;
};

/** A line of `xcodebuild` output that says the runner cannot start. */
export function classifyXcodebuildLine(line: string): RunnerFault | undefined {
	const message = line.trim();
	if (/Unlock .* to Continue/i.test(line)) return { kind: "device_locked", message };
	if (/Developer Mode/i.test(line) && /disabled|not enabled|turn on/i.test(line)) {
		return { kind: "developer_mode_off", message };
	}
	if (/not trusted|Untrusted Developer|profile has not been explicitly trusted/i.test(line)) {
		return { kind: "runner_untrusted", message };
	}
	if (/Failed to establish communication with the test runner|already .*(testing|being tested)/i.test(line)) {
		return { kind: "device_busy", message };
	}
	if (line.includes(FAILED_PREFIX)) return { kind: "runner_failed", message };
	return undefined;
}

/** `IXRemoteErrorDomain` code 6: the install raced a tunnel that was not connected yet. */
export function isInstallRace(line: string): boolean {
	return line.includes("IXRemoteErrorDomain") && /\b(?:code|error)\W{0,3}6\b/i.test(line);
}

/** The port in a `WARDEN_RUNNER_READY {json}` line, or undefined for any other line. */
export function readyPort(line: string): number | undefined {
	const at = line.indexOf(READY_PREFIX);
	if (at < 0) return undefined;
	try {
		const port: unknown = JSON.parse(line.slice(at + READY_PREFIX.length).trim()).port;
		return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : undefined;
	} catch {
		return undefined;
	}
}

export function xcodebuildCommand(artifacts: RunnerArtifacts, udid: string): string[] {
	return [
		"xcodebuild",
		"test-without-building",
		"-xctestrun",
		artifacts.xctestrun,
		"-destination",
		`id=${udid}`,
		TEST_FILTER,
	];
}

/** `TEST_RUNNER_<NAME>` is how `xcodebuild` passes env to the UI-test runner. No port: the runner picks a free one and says which. */
export function runnerEnv(input: SessionInput): Record<string, string> {
	return {
		TEST_RUNNER_WARDEN_RUNNER_UDID: input.udid,
		TEST_RUNNER_WARDEN_RUNNER_IDLE_SECONDS: String(input.runnerIdleSeconds),
	};
}

type Outcome =
	| { kind: "ready"; port: number }
	| { kind: "fault"; fault: RunnerFault }
	| { kind: "install_race" }
	| { kind: "exit"; code: number | null }
	| { kind: "timeout" };

type Watch = {
	proc: RunnerProcess;
	/** the first thing that happened before ready */
	outcome: Promise<Outcome>;
	/** the fault line seen after ready, if any */
	lateFault: () => RunnerFault | undefined;
	tail: () => string;
	/** resolves with the exit code once the process is gone and its output is read */
	finished: Promise<number | null>;
};

async function pump(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
	const decoder = new TextDecoder();
	let pending = "";
	try {
		for await (const chunk of stream) {
			const lines = (pending + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) onLine(line);
		}
	} catch {
		// a killed process closes its pipes mid-read
	}
	if (pending.trim() !== "") onLine(pending);
}

function watch(proc: RunnerProcess, deps: SessionDeps): Watch {
	let settle: (outcome: Outcome) => void = () => undefined;
	const outcome = new Promise<Outcome>((resolve) => {
		settle = resolve;
	});
	const tail: string[] = [];
	let ready = false;
	let late: RunnerFault | undefined;
	const onLine = (line: string): void => {
		if (line.trim() === "") return;
		deps.log(line);
		tail.push(line);
		if (tail.length > TAIL_LINES) tail.shift();
		if (ready) {
			late ??= classifyXcodebuildLine(line);
			return;
		}
		const port = readyPort(line);
		if (port !== undefined) {
			ready = true;
			settle({ kind: "ready", port });
			return;
		}
		if (isInstallRace(line)) {
			settle({ kind: "install_race" });
			return;
		}
		const fault = classifyXcodebuildLine(line);
		if (fault !== undefined) settle({ kind: "fault", fault });
	};
	const finished = Promise.all([
		pump(proc.stdout, onLine),
		pump(proc.stderr, onLine),
		proc.exited.catch(() => null),
	]).then(([, , code]) => {
		settle({ kind: "exit", code });
		return code;
	});
	return { proc, outcome, lateFault: () => late, tail: () => tail.join(" | "), finished };
}

async function terminate(w: Watch, deps: SessionDeps): Promise<void> {
	w.proc.kill("SIGTERM");
	let cancel: () => void = () => undefined;
	const stuck = new Promise<"stuck">((resolve) => {
		cancel = deps.after(STOP_WAIT_MS, () => resolve("stuck"));
	});
	const result = await Promise.race([w.finished.then(() => "gone" as const), stuck]);
	cancel();
	if (result === "stuck") {
		w.proc.kill("SIGKILL");
		await w.finished;
	}
}

async function launch(
	deps: SessionDeps,
	input: SessionInput,
	attempt: 1 | 2
): AsyncResult<{ watch: Watch; port: number }, RunnerFault> {
	const connected = await waitTunnelConnected(deps.route, input.udid, deps.tunnelWaitMs);
	if (!connected.success) return { success: false, error: { kind: "tunnel_down", message: connected.error.message } };
	deps.log(`xcodebuild: starting the runner on ${input.udid} (attempt ${attempt})`);
	const w = watch(deps.spawn(xcodebuildCommand(input.artifacts, input.udid), runnerEnv(input)), deps);
	let cancelTimer: () => void = () => undefined;
	const timeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
	const timedOut = new Promise<Outcome>((resolve) => {
		cancelTimer = deps.after(timeoutMs, () => resolve({ kind: "timeout" }));
	});
	const first = await Promise.race([w.outcome, timedOut]);
	cancelTimer();
	switch (first.kind) {
		case "ready":
			return { success: true, data: { watch: w, port: first.port } };
		case "install_race": {
			await terminate(w, deps);
			if (attempt === 1) {
				deps.log("xcodebuild: IXRemoteErrorDomain 6 during install, retrying once");
				return launch(deps, input, 2);
			}
			return {
				success: false,
				error: { kind: "install_failed", message: `install failed twice (IXRemoteErrorDomain 6): ${w.tail()}` },
			};
		}
		case "fault":
			await terminate(w, deps);
			return { success: false, error: first.fault };
		case "timeout":
			await terminate(w, deps);
			return {
				success: false,
				error: {
					kind: "ready_timeout",
					message: `runner not ready after ${Math.round(timeoutMs / 1000)} s (is the phone unlocked?): ${w.tail()}`,
				},
			};
		case "exit":
			return {
				success: false,
				error: {
					kind: "xcodebuild_exited",
					exitCode: first.code,
					message: `xcodebuild exited ${first.code ?? "by signal"} before the runner was ready: ${w.tail()}`,
				},
			};
	}
}

/**
 * Start the runner and wait until it prints its ready line. Resolves with where to reach it (tunnel address read
 * AFTER the install, runner port from the ready line) or the classified fault; on a fault `xcodebuild` is stopped.
 */
export async function startSession(deps: SessionDeps, input: SessionInput): AsyncResult<Session, RunnerFault> {
	const launched = await launch(deps, input, 1);
	if (!launched.success) return launched;
	const { watch: w, port } = launched.data;
	const ip = await readTunnelIp(deps.route, input.udid);
	if (!ip.success) {
		await terminate(w, deps);
		return { success: false, error: { kind: "tunnel_down", message: ip.error.message } };
	}
	let stopping = false;
	const ended = w.finished.then((code): SessionEnd => {
		if (stopping || code === 0) return { kind: "clean" };
		const late = w.lateFault();
		return {
			kind: "fault",
			fault: late ?? {
				kind: "xcodebuild_exited",
				exitCode: code,
				message: `xcodebuild exited ${code ?? "by signal"}: ${w.tail()}`,
			},
		};
	});
	return {
		success: true,
		data: {
			address: { host: ip.data, port },
			ended,
			stop: async () => {
				stopping = true;
				await terminate(w, deps);
			},
		},
	};
}
