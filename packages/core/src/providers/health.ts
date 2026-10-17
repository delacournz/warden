import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { Exec, ExecResult } from "../exec";

export const PROBE_TIMEOUT_MS = 5_000;
/** A probe that timed out is asked once more, with this much longer: a busy host is not a hung sim. */
export const PROBE_RETRY_FACTOR = 3;

/** A cancellable timer: `promise` resolves after `ms` unless `cancel` runs first. */
export type Timer = { promise: Promise<void>; cancel: () => void };

export function realTimer(ms: number): Timer {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<void>((resolve) => {
		handle = setTimeout(resolve, ms);
	});
	return { promise, cancel: () => clearTimeout(handle) };
}

/** An exec plus the timer that bounds it. */
export type TimedExec = {
	exec: Exec;
	/** the timeout timer — tests resolve it immediately instead of waiting */
	timer: (ms: number) => Timer;
};

export type HealthDeps = TimedExec & { timeoutMs?: number };

/** What a probe error says when the sim gave no answer in time (as opposed to a wrong answer). */
export const PROBE_NO_ANSWER = "did not answer within";

/** The probe failed because the sim did not answer in time, not because SpringBoard is down or launchctl failed. */
export function isProbeTimeout(error: string): boolean {
	return error.includes(PROBE_NO_ANSWER);
}

/** Exit codes of a process killed for running past its timeout: 124 (`timeout(1)`), 143 (SIGTERM, Bun's `timeout`). */
const KILLED_EXIT_CODES = new Set([124, 143]);

const spawn = (udid: string, ...args: string[]) => ["xcrun", "simctl", "spawn", udid, ...args];

/**
 * Run `cmd`, giving up (undefined) after `timeoutMs`. The exec gets the same timeout so a real process
 * is killed; the timer race bounds an exec that never returns at all.
 */
export async function execWithin(
	deps: TimedExec,
	cmd: readonly string[],
	timeoutMs: number
): Promise<ExecResult | undefined> {
	const timer = deps.timer(timeoutMs);
	try {
		const res = await Promise.race([deps.exec(cmd, { timeoutMs }), timer.promise.then((): undefined => undefined)]);
		// a killed exec is the same "no answer" as our own timer firing first
		return res !== undefined && KILLED_EXIT_CODES.has(res.exitCode) ? undefined : res;
	} finally {
		timer.cancel();
	}
}

/** `once`, and when it times out, one more try with `PROBE_RETRY_FACTOR` times as long. */
async function withTimeout(deps: HealthDeps, cmd: string[]): Promise<ExecResult | undefined> {
	const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
	return (await execWithin(deps, cmd, timeoutMs)) ?? (await execWithin(deps, cmd, timeoutMs * PROBE_RETRY_FACTOR));
}

/** `launchctl list` rows are `PID\tStatus\tLabel`; SpringBoard is a job with a numeric pid. */
export function springboardRunning(launchctlList: string): boolean {
	return launchctlList.split("\n").some((line) => {
		const [pid, , label] = line.split("\t");
		return label !== undefined && /springboard/i.test(label) && /^\d+$/.test(pid ?? "");
	});
}

/**
 * iOS claim health probe: the booted simulator's launchd answers `launchctl print system` within
 * the timeout (retried once, longer, so a loaded host does not get a healthy sim quarantined) and
 * SpringBoard is running. A hung or half-booted sim fails one of the two. The two are independent,
 * so they are asked at the same time.
 */
export async function probeIosHealth(deps: HealthDeps, udid: string): AsyncResult<void> {
	const seconds = ((deps.timeoutMs ?? PROBE_TIMEOUT_MS) * PROBE_RETRY_FACTOR) / 1000;
	const [print, list] = await Promise.all([
		withTimeout(deps, spawn(udid, "launchctl", "print", "system")),
		withTimeout(deps, spawn(udid, "launchctl", "list")),
	]);
	if (print === undefined) return err(`${udid}: launchctl print system ${PROBE_NO_ANSWER} ${seconds}s`);
	if (print.exitCode !== 0) return err(`${udid}: launchctl print system exited ${print.exitCode}`);
	if (list === undefined) return err(`${udid}: launchctl list ${PROBE_NO_ANSWER} ${seconds}s`);
	if (list.exitCode !== 0 || !springboardRunning(list.stdout)) return err(`${udid}: SpringBoard is not running`);
	return ok(undefined);
}

/**
 * Probe for a simulator that was already Booted when claimed: one `launchctl list`. It answering at
 * all proves launchd is up (so `launchctl print system` and `bootstatus` would add nothing), and
 * SpringBoard running proves the boot finished. A failure is not a verdict — the caller falls back to
 * `bootstatus` + the full probe, since a sim another process was still booting looks like this.
 */
export async function probeIosWarm(deps: HealthDeps, udid: string): AsyncResult<void> {
	const seconds = ((deps.timeoutMs ?? PROBE_TIMEOUT_MS) * PROBE_RETRY_FACTOR) / 1000;
	const list = await withTimeout(deps, spawn(udid, "launchctl", "list"));
	if (list === undefined) return err(`${udid}: launchctl list ${PROBE_NO_ANSWER} ${seconds}s`);
	if (list.exitCode !== 0 || !springboardRunning(list.stdout)) return err(`${udid}: SpringBoard is not running`);
	return ok(undefined);
}
