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

export type HealthDeps = {
	exec: Exec;
	/** the timeout timer — tests resolve it immediately instead of waiting */
	timer: (ms: number) => Timer;
	timeoutMs?: number;
};

const spawn = (udid: string, ...args: string[]) => ["xcrun", "simctl", "spawn", udid, ...args];

/** Run `cmd`, giving up (undefined) after `timeoutMs`. The exec gets the same timeout so a real process is killed. */
async function once(deps: HealthDeps, cmd: string[], timeoutMs: number): Promise<ExecResult | undefined> {
	const timer = deps.timer(timeoutMs);
	try {
		const res = await Promise.race([deps.exec(cmd, { timeoutMs }), timer.promise.then((): undefined => undefined)]);
		// a killed exec reports 124: the same "no answer" as our own timer firing first
		return res?.exitCode === 124 ? undefined : res;
	} finally {
		timer.cancel();
	}
}

/** `once`, and when it times out, one more try with `PROBE_RETRY_FACTOR` times as long. */
async function withTimeout(deps: HealthDeps, cmd: string[]): Promise<ExecResult | undefined> {
	const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
	return (await once(deps, cmd, timeoutMs)) ?? (await once(deps, cmd, timeoutMs * PROBE_RETRY_FACTOR));
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
 * SpringBoard is running. A hung or half-booted sim fails one of the two.
 */
export async function probeIosHealth(deps: HealthDeps, udid: string): AsyncResult<void> {
	const seconds = ((deps.timeoutMs ?? PROBE_TIMEOUT_MS) * PROBE_RETRY_FACTOR) / 1000;
	const print = await withTimeout(deps, spawn(udid, "launchctl", "print", "system"));
	if (print === undefined) return err(`${udid}: launchctl print system did not answer within ${seconds}s`);
	if (print.exitCode !== 0) return err(`${udid}: launchctl print system exited ${print.exitCode}`);
	const list = await withTimeout(deps, spawn(udid, "launchctl", "list"));
	if (list === undefined) return err(`${udid}: launchctl list did not answer within ${seconds}s`);
	if (list.exitCode !== 0 || !springboardRunning(list.stdout)) return err(`${udid}: SpringBoard is not running`);
	return ok(undefined);
}
