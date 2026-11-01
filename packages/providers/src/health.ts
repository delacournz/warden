import type { Exec, ExecResult } from "@delacour/warden-runtime/exec";
import { type WardenError, wardenErrors } from "@delacour/warden-types/error";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";

export const PROBE_TIMEOUT_MS = 5_000;
/** A probe that timed out is asked once more, with this much longer: a busy host is not a hung sim. */
export const PROBE_RETRY_FACTOR = 3;

/** A cancellable timer: `promise` resolves after `ms` unless `cancel` runs first. */
export type Timer = { promise: Promise<void>; cancel: () => void };

/** The real timer; tests pass their own `(ms) => Timer` instead. */
export class Timers {
	readonly real = (ms: number): Timer => {
		let handle: ReturnType<typeof setTimeout> | undefined;
		const promise = new Promise<void>((resolve) => {
			handle = setTimeout(resolve, ms);
		});
		return { promise, cancel: () => clearTimeout(handle) };
	};
}

export const timers = new Timers();

/** An exec plus the timer that bounds it. */
export type TimedExec = {
	exec: Exec;
	/** the timeout timer — tests resolve it immediately instead of waiting */
	timer: (ms: number) => Timer;
};

export type HealthDeps = TimedExec & { timeoutMs?: number };

/** What a probe error says when the sim gave no answer in time (as opposed to a wrong answer). */
export const PROBE_NO_ANSWER = "did not answer within";

/** A probe failure is coded: `probe_timeout` = the sim did not answer in time, `failed` = it answered wrongly (SpringBoard down, launchctl failed). */
export type ProbeResult = AsyncResult<void, WardenError>;

/** Exit codes of a process killed for running past its timeout: 124 (`timeout(1)`), 143 (SIGTERM, Bun's `timeout`). */
const KILLED_EXIT_CODES = new Set([124, 143]);

/**
 * Runs commands within a time budget. The exec gets the same timeout so a real process is killed; the timer
 * race bounds an exec that never returns at all.
 */
export class BoundedExec {
	constructor(private readonly deps: TimedExec) {}

	/** Run `cmd`, giving up (undefined) after `timeoutMs`. */
	async within(cmd: readonly string[], timeoutMs: number): Promise<ExecResult | undefined> {
		const timer = this.deps.timer(timeoutMs);
		try {
			const res = await Promise.race([
				this.deps.exec(cmd, { timeoutMs }),
				timer.promise.then((): undefined => undefined),
			]);
			// a killed exec is the same "no answer" as our own timer firing first
			return res !== undefined && KILLED_EXIT_CODES.has(res.exitCode) ? undefined : res;
		} finally {
			timer.cancel();
		}
	}
}

/** Reads `launchctl list` output. */
export class LaunchctlRows {
	/** `launchctl list` rows are `PID\tStatus\tLabel`; SpringBoard is a job with a numeric pid. */
	springboardRunning(launchctlList: string): boolean {
		return launchctlList.split("\n").some((line) => {
			const [pid, , label] = line.split("\t");
			return label !== undefined && /springboard/i.test(label) && /^\d+$/.test(pid ?? "");
		});
	}
}

export const launchctlRows = new LaunchctlRows();

/** iOS simulator health probes, over `simctl spawn … launchctl`. */
export class IosHealth {
	private readonly bounded: BoundedExec;

	constructor(private readonly deps: HealthDeps) {
		this.bounded = new BoundedExec(deps);
	}

	/**
	 * iOS claim health probe: the booted simulator's launchd answers `launchctl print system` within
	 * the timeout (retried once, longer, so a loaded host does not get a healthy sim quarantined) and
	 * SpringBoard is running. A hung or half-booted sim fails one of the two. The two are independent,
	 * so they are asked at the same time.
	 */
	async probe(udid: string): ProbeResult {
		const seconds = this.totalSeconds();
		const [print, list] = await Promise.all([
			this.withRetry(this.spawn(udid, "launchctl", "print", "system")),
			this.withRetry(this.spawn(udid, "launchctl", "list")),
		]);
		if (print === undefined)
			return wardenErrors.err("probe_timeout", `${udid}: launchctl print system ${PROBE_NO_ANSWER} ${seconds}s`, {
				retryable: true,
			});
		if (print.exitCode !== 0)
			return wardenErrors.err("failed", `${udid}: launchctl print system exited ${print.exitCode}`);
		return this.judgeList(udid, list, seconds);
	}

	/**
	 * Probe for a simulator that was already Booted when claimed: one `launchctl list`. It answering at
	 * all proves launchd is up (so `launchctl print system` and `bootstatus` would add nothing), and
	 * SpringBoard running proves the boot finished. A failure is not a verdict — the caller falls back to
	 * `bootstatus` + the full probe, since a sim another process was still booting looks like this.
	 */
	async probeWarm(udid: string): ProbeResult {
		const list = await this.withRetry(this.spawn(udid, "launchctl", "list"));
		return this.judgeList(udid, list, this.totalSeconds());
	}

	private judgeList(udid: string, list: ExecResult | undefined, seconds: number): Result<void, WardenError> {
		if (list === undefined)
			return wardenErrors.err("probe_timeout", `${udid}: launchctl list ${PROBE_NO_ANSWER} ${seconds}s`, {
				retryable: true,
			});
		if (list.exitCode !== 0 || !launchctlRows.springboardRunning(list.stdout))
			return wardenErrors.err("failed", `${udid}: SpringBoard is not running`);
		return resultFactory.ok(undefined);
	}

	private totalSeconds(): number {
		return ((this.deps.timeoutMs ?? PROBE_TIMEOUT_MS) * PROBE_RETRY_FACTOR) / 1000;
	}

	/** `once`, and when it times out, one more try with `PROBE_RETRY_FACTOR` times as long. */
	private async withRetry(cmd: string[]): Promise<ExecResult | undefined> {
		const timeoutMs = this.deps.timeoutMs ?? PROBE_TIMEOUT_MS;
		return (
			(await this.bounded.within(cmd, timeoutMs)) ?? (await this.bounded.within(cmd, timeoutMs * PROBE_RETRY_FACTOR))
		);
	}

	private spawn(udid: string, ...args: string[]): string[] {
		return ["xcrun", "simctl", "spawn", udid, ...args];
	}
}
