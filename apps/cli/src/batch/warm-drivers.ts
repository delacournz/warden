import { join } from "node:path";
import type { BatchWorker } from "@delacour/warden-core/batch/schedule";
import type { AsyncResult } from "@delacour/warden-types/result";

/** A running socket helper for one device, as the warm step needs it. */
export type WarmHelper = {
	/** where jobs reach it (`WARDEN_SIMD_SOCKET`) */
	socketPath: string;
	/** one UI snapshot: makes the in-sim bridge resident */
	snapshot: () => AsyncResult<unknown>;
	/** disconnect from the helper; it stays resident for the jobs and after the run */
	close: () => Promise<void>;
	/**
	 * stop the helper process itself (and disconnect): for a helper whose device will run its jobs cold, which
	 * would otherwise each spawn a helper of their own beside it (two quiescence streams on one sim, 20-1)
	 */
	stop?: () => Promise<void>;
	/**
	 * clear a wedged in-sim accessibility service (see `e2e/ax-wedge`): asked after each snapshot that timed out, until
	 * one recovers (at most one recovery per device). `recovered` means the device's UI stack was restarted
	 * and this helper stopped, so the warm loop connects a fresh one; `not-wedged` / `failed` leave this helper in use
	 */
	recover?: () => Promise<WarmRecovery>;
	/**
	 * reboot the device: the last resort for a wedged accessibility service that `recover` found but could not restart
	 * backboardd for, or restarted it and snapshots still time out (`REBOOT_AFTER_TRIES`). At most once per device, after
	 * `WarmRun.quiet`. `rebooted`: this helper stopped and the sim is booted and ready again, so the warm loop connects a
	 * fresh helper; `refused`: warden may not reboot it, this helper stays in use; `failed`: this helper stopped, the
	 * device goes cold
	 */
	reboot?: () => Promise<WarmReboot>;
};

/**
 * One `WarmHelper.recover` attempt. A failure's `stage`: `log` (the wedge could not be looked for) or `restart` (wedged,
 * and backboardd could not be restarted: the warm loop reboots).
 */
export type WarmRecovery =
	| { kind: "recovered"; note: string }
	| { kind: "not-wedged" }
	| { kind: "failed"; error: string; stage?: "log" | "restart" };

/** One `WarmHelper.reboot` attempt; a failure names the step that failed (`shutdown`, `boot`, `ready`). */
export type WarmReboot =
	| { kind: "rebooted" }
	| { kind: "refused"; reason: string }
	| { kind: "failed"; stage: string; error: string };

/** Connect to (spawning when needed) the socket helper of one device. */
export type WarmConnect = (udid: string) => AsyncResult<WarmHelper>;

export const WARM_TIMEOUT_MS = 120_000;

/**
 * What one reboot adds to its device's warm budget (`WARM_TIMEOUT_MS` is unchanged otherwise): the reboot itself
 * (shutdown + `bootstatus -b`, ~30-60 s on CI), a fresh helper and its first reads. A device is rebooted at most once,
 * so its budget is at most `WARM_TIMEOUT_MS + REBOOT_ALLOWANCE_MS`.
 */
export const REBOOT_ALLOWANCE_MS = 90_000;

/**
 * Failed snapshots on the fresh helper of a device whose backboardd was restarted before it is rebooted: a fresh
 * helper reads ~13 s after the restart (one 10 s timeout, maybe two), so three in a row (~40 s) is a wedge that stayed.
 */
export const REBOOT_AFTER_TRIES = 3;
/** One device's warm-up outcome. */
export type Warmed = {
	worker: number;
	udid: string;
	ok: boolean;
	/** the helper's socket, when it is warm */
	socketPath?: string;
	/** why it is not warm (only ever a warning) */
	error?: string;
	/** a wedged accessibility service found on this device: recovered, or the last recovery that failed */
	axRecovery?: AxRecoveryRecord;
	log: string;
};

/**
 * What became of a device's wedged accessibility service (absent: never found wedged): backboardd restarted
 * (`recovered`), the sim rebooted (`rebooted`), or the last step that failed (`stage`: `log`, `restart` or `reboot`;
 * absent from an older helper).
 */
export type AxRecoveryRecord =
	| { outcome: "recovered" }
	| { outcome: "rebooted" }
	| { outcome: "failed"; error: string; stage?: "log" | "restart" | "reboot" };

export type WarmRun = {
	/** the iOS devices to warm */
	devices: readonly BatchWorker[];
	logDir: string;
	now: () => number;
	/** run `fn` once after `ms`; returns cancel */
	after: (ms: number, fn: () => void) => () => void;
	writeFile: (path: string, data: string) => Promise<void>;
	/** SIGINT: stop waiting (helpers that come up late are closed) */
	signal?: AbortSignal;
	/**
	 * resolves once nothing else is working on the device (its app install, setup, Metro launch): a reboot waits for it,
	 * so it never cuts one short. Absent: reboot at once
	 */
	quiet?: (udid: string) => Promise<void>;
};

export type WarmDeps = {
	connect: WarmConnect;
	timeoutMs?: number;
	/** a warning line for the terminal */
	warn?: (line: string) => void;
	/** one device's outcome the moment it settles (its helper when warm, its warning when not), before the others */
	onDevice?: (device: Warmed, helper: WarmHelper | undefined, warning: string | undefined) => void;
};

export type WarmOutcome = {
	devices: Warmed[];
	/** the helpers that are warm: close them when the run ends */
	helpers: WarmHelper[];
};

type Step = { helper?: WarmHelper; error?: string; axRecovery?: AxRecoveryRecord };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A helper whose device goes cold: stopped when it can be (else only disconnected); never throws. */
const discard = (helper: WarmHelper): Promise<void> => (helper.stop ? helper.stop() : helper.close()).catch(() => {});

/** Stop (else disconnect) the helper of a device that goes cold, and say so in its log. */
async function coldHelper(helper: WarmHelper, note: (line: string) => void): Promise<void> {
	await discard(helper);
	note(helper.stop ? "stopped the helper: this device's jobs start their own" : "closed the helper");
}

/** Wait before the second snapshot try, then between later ones: the in-sim bridge is up but silent, not gone. */
const FIRST_RETRY_WAIT_MS = 2_000;
const RETRY_WAIT_MS = 5_000;

/** Why the device's wait ended early, as the caller knows it: the outer timeout, or a SIGINT. */
type Late = "timeout" | "interrupt" | undefined;

type Stop = {
	/** aborted when the device's wait has ended (settled, timed out or interrupted): no more retries after it */
	signal: AbortSignal;
	late: () => Late;
	/** push the device's deadline back by `ms` (a reboot) */
	extend: (ms: number) => void;
};

/** Wait `ms` through `run.after`; resolves false when `stop` aborted first (the timer is cancelled). */
function pause(run: WarmRun, ms: number, stop: AbortSignal): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		if (stop.aborted) return resolve(false);
		const onAbort = () => {
			cancel();
			resolve(false);
		};
		const cancel = run.after(ms, () => {
			stop.removeEventListener("abort", onAbort);
			resolve(true);
		});
		stop.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * The failed try from which the helper is asked to recover: the first. A wedged sim's first read already times out,
 * and checking costs one log read (~2 s) on a sim that is only slow.
 */
const RECOVER_FROM_TRY = 1;

/**
 * A wedged accessibility service shows only as reads that time out (`E_TIMEOUT`, `did not answer within …`). A try
 * that failed fast (a fresh home screen names no frontmost app) never asks to recover: the sim log can carry the
 * wedge marker on a sim that still answers, and a needless restart quits the app.
 */
const TIMED_OUT = /E_TIMEOUT|did not answer within/;

/** Resolves true once `work` settles, false when `stop` aborted first. */
function settledBefore(work: Promise<unknown>, stop: AbortSignal): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		if (stop.aborted) return resolve(false);
		const onAbort = () => resolve(false);
		stop.addEventListener("abort", onAbort, { once: true });
		const done = () => {
			stop.removeEventListener("abort", onAbort);
			resolve(true);
		};
		work.then(done, done);
	});
}

/**
 * The helper in use and how far up the ladder the device is: one backboardd restart (`recovered`), then one reboot
 * (`rebootTried`, after which nothing more is tried), and what became of it.
 */
type Recovering = {
	helper: WarmHelper;
	recovered: boolean;
	/** snapshots in a row that timed out on the helper connected after the backboardd restart (a fast failure resets it) */
	failsSinceRecovery: number;
	/** wedged, and backboardd could not be restarted */
	restartFailed: boolean;
	rebootTried: boolean;
	record?: AxRecoveryRecord;
};

/** What the ladder steps share: the run, `connect`, the device, its stop and its log. */
type Ladder = {
	run: WarmRun;
	connect: WarmConnect;
	udid: string;
	stop: Stop;
	note: (line: string) => void;
	/** grow the loop's budget and the device's deadline */
	grow: (ms: number) => void;
};

/** Where the snapshot loop ended: `error` undefined = warm. `helper` is the one in use then (a recovery replaces it). */
type Snapped = { helper: WarmHelper | undefined; error?: string; axRecovery?: AxRecoveryRecord };

const ended = (state: Recovering, helper: WarmHelper | undefined, error?: string): Snapped => ({
	helper,
	...(error !== undefined ? { error } : {}),
	...(state.record ? { axRecovery: state.record } : {}),
});

/** Connect a fresh helper after the device's UI stack was restarted; returns the connect's error. */
async function reconnect(l: Ladder, state: Recovering): Promise<string | undefined> {
	try {
		const fresh = await l.connect(l.udid);
		if (!fresh.success) return fresh.error;
		l.note(`connected ${fresh.data.socketPath}`);
		state.helper = fresh.data;
		return undefined;
	} catch (error) {
		return message(error);
	}
}

/**
 * After a failed try: ask the helper to recover, unless the device was recovered (or a reboot tried) already. A
 * recovered device gets a fresh helper through `connect`: the old one stopped itself and its in-sim guest still talks to
 * the dead server. Updates `state`; returns the reconnect's error.
 */
async function recoverOnce(l: Ladder, state: Recovering): Promise<string | undefined> {
	const recover = state.helper.recover;
	if (state.recovered || state.rebootTried || !recover) return undefined;
	const outcome = await recover().catch((error: unknown): WarmRecovery => ({ kind: "failed", error: message(error) }));
	if (outcome.kind === "not-wedged") return undefined;
	if (outcome.kind === "failed") {
		l.note(`accessibility service recovery failed: ${outcome.error}`);
		state.record = { outcome: "failed", error: outcome.error, ...(outcome.stage ? { stage: outcome.stage } : {}) };
		if (outcome.stage === "restart") state.restartFailed = true;
		return undefined;
	}
	l.note(`accessibility service wedged: ${outcome.note}; reconnecting`);
	state.recovered = true;
	state.record = { outcome: "recovered" };
	return reconnect(l, state);
}

/** Why the device is due its one reboot, else undefined. */
function rebootDue(state: Recovering): string | undefined {
	if (state.rebootTried || !state.helper.reboot) return undefined;
	if (state.restartFailed) return "backboardd could not be restarted";
	if (state.recovered && state.failsSinceRecovery >= REBOOT_AFTER_TRIES)
		return `still not answering ${state.failsSinceRecovery} snapshots after the backboardd restart`;
	return undefined;
}

/**
 * Reboot the device once (its budget grows by `REBOOT_ALLOWANCE_MS` first), after whatever else works on it is done
 * (`WarmRun.quiet`), then connect a fresh helper. Updates `state`; returns the error that leaves the device cold (a
 * failed reboot, or the reconnect's); a refused reboot carries on with the same helper.
 */
async function rebootOnce(l: Ladder, state: Recovering, why: string): Promise<string | undefined> {
	const reboot = state.helper.reboot;
	if (!reboot) return undefined;
	state.rebootTried = true;
	l.grow(REBOOT_ALLOWANCE_MS);
	if (l.run.quiet) {
		l.note("waiting for the device's app install and setup to finish before rebooting it");
		if (!(await settledBefore(l.run.quiet(l.udid), l.stop.signal))) return undefined;
	}
	l.note(`rebooting ${l.udid}: ${why}`);
	const outcome = await reboot().catch(
		(error: unknown): WarmReboot => ({ kind: "failed", stage: "reboot", error: message(error) })
	);
	if (outcome.kind === "refused") {
		l.note(`reboot refused: ${outcome.reason}`);
		state.record = { outcome: "failed", stage: "reboot", error: `refused: ${outcome.reason}` };
		return undefined;
	}
	if (outcome.kind === "failed") {
		const error = `${outcome.stage}: ${outcome.error}`;
		l.note(`reboot failed: ${error}`);
		state.record = { outcome: "failed", stage: "reboot", error };
		return `reboot failed: ${error}`;
	}
	l.note("rebooted; reconnecting");
	state.record = { outcome: "rebooted" };
	return reconnect(l, state);
}

/** After a failed try: the next rung of the ladder (recover, then reboot). Returns the error that ends the loop. */
async function climb(l: Ladder, state: Recovering): Promise<string | undefined> {
	const recoverError = await recoverOnce(l, state);
	if (recoverError !== undefined) return recoverError;
	const why = rebootDue(state);
	return why === undefined ? undefined : rebootOnce(l, state, why);
}

/**
 * After a failed try: the ladder's next rung, only for a try that timed out (a fast failure is a sim that answers, and
 * resets the count of timeouts since a backboardd restart). Returns the error that ends the loop.
 */
function afterFailure(
	ladder: Ladder,
	state: Recovering,
	attempt: number,
	lastError: string
): Promise<string | undefined> {
	const timedOut = TIMED_OUT.test(lastError);
	if (state.recovered) state.failsSinceRecovery = timedOut ? state.failsSinceRecovery + 1 : 0;
	return attempt >= RECOVER_FROM_TRY && timedOut ? climb(ladder, state) : Promise.resolve(undefined);
}

/**
 * Snapshot with backoff until one succeeds or the budget or `stop` ends it (the last error). The budget counts the
 * clock and, as a floor, the time slept, so a clock that stands still cannot retry forever. Each try that times out
 * moves up the ladder (`afterFailure`): recover a wedged device (once), then reboot it (once, growing the budget by
 * `REBOOT_ALLOWANCE_MS`), the loop carrying on with the helper reconnected after either.
 */
async function snapshotUntilWarm(
	run: WarmRun,
	connect: WarmConnect,
	udid: string,
	first: WarmHelper,
	budgetMs: number,
	stop: Stop,
	note: (line: string) => void
): Promise<Snapped> {
	const started = run.now();
	const state: Recovering = {
		helper: first,
		recovered: false,
		failsSinceRecovery: 0,
		restartFailed: false,
		rebootTried: false,
	};
	let budget = budgetMs;
	const grow = (ms: number) => {
		budget += ms;
		stop.extend(ms);
	};
	const ladder: Ladder = { run, connect, udid, stop, note, grow };
	let waited = 0;
	for (let attempt = 1; ; attempt++) {
		const lastError = await snapshotOnce(state.helper);
		if (lastError === undefined) return ended(state, state.helper);
		const wait = attempt === 1 ? FIRST_RETRY_WAIT_MS : RETRY_WAIT_MS;
		const spent = Math.max(run.now() - started, waited);
		if (givingUp(stop, spent + wait >= budget, attempt, lastError, note)) return ended(state, state.helper, lastError);
		const reconnectError = await afterFailure(ladder, state, attempt, lastError);
		if (reconnectError !== undefined) return ended(state, undefined, reconnectError);
		if (!(await pause(run, wait, stop.signal))) return ended(state, state.helper, lastError);
		waited += wait;
	}
}

/** Log a failed try; true when the loop ends on it (budget spent or `stop` aborted). */
function givingUp(
	stop: Stop,
	spent: boolean,
	attempt: number,
	lastError: string,
	note: (line: string) => void
): boolean {
	const out = stop.signal.aborted || spent;
	note(
		`snapshot try ${attempt} failed: ${lastError.replace(/^snapshot failed: /, "")}; ${out ? "giving up" : "retrying"}`
	);
	return out;
}

/** One snapshot on `helper`: undefined when it succeeded, else the error (never throws). */
async function snapshotOnce(helper: WarmHelper): Promise<string | undefined> {
	try {
		const shot = await helper.snapshot();
		return shot.success ? undefined : `snapshot failed: ${shot.error}`;
	} catch (error) {
		return `snapshot failed: ${message(error)}`;
	}
}

/**
 * `connect`, then snapshot until one succeeds or the budget is spent (a loaded host's bridge can stay silent
 * longer than one ~10 s snapshot): 2 s after the first failure, 5 s between later tries. Never throws. A
 * helper that connects but never snapshots is stopped: it may be wedged, so the device's jobs are not handed
 * its socket, and it must not stay resident beside their own helpers.
 */
async function warmOne(
	run: WarmRun,
	connect: WarmConnect,
	udid: string,
	budgetMs: number,
	stop: Stop,
	note: (line: string) => void
): Promise<Step> {
	const started = run.now();
	let first: WarmHelper;
	try {
		const connected = await connect(udid);
		if (!connected.success) return { error: connected.error };
		first = connected.data;
	} catch (error) {
		return { error: message(error) };
	}
	note(`connected ${first.socketPath}`);
	const left = budgetMs - (run.now() - started);
	const { helper, error, axRecovery } = await snapshotUntilWarm(run, connect, udid, first, left, stop, note);
	const record = axRecovery ? { axRecovery } : {};
	if (error === undefined && helper) return { helper, ...record };
	if (helper) {
		if (stop.late() === "interrupt") await helper.close().catch(() => {});
		else await coldHelper(helper, note);
	}
	return { error: error ?? "not warm", ...record };
}

/** One device's step: its warm-up raced against the budget and the interrupt; a helper that arrives late is discarded. */
function settleDevice(
	run: WarmRun,
	connect: WarmConnect,
	udid: string,
	budgetMs: number,
	note: (line: string) => void
): Promise<Step> {
	if (run.signal?.aborted) return Promise.resolve({ error: "interrupted" });
	let late: Late;
	const stopper = new AbortController();
	const started = run.now();
	let total = budgetMs;
	return new Promise<Step>((resolve) => {
		const finish = (s: Step) => {
			cancel();
			run.signal?.removeEventListener("abort", onAbort);
			stopper.abort();
			resolve(s);
		};
		const onTimeout = () => {
			late = "timeout";
			finish({ error: `timed out after ${total / 1000}s` });
		};
		let cancel = run.after(budgetMs, onTimeout);
		const onAbort = () => {
			late = "interrupt";
			finish({ error: "interrupted" });
		};
		run.signal?.addEventListener("abort", onAbort, { once: true });
		const extend = (ms: number) => {
			if (stopper.signal.aborted) return;
			cancel();
			total += ms;
			cancel = run.after(Math.max(0, started + total - run.now()), onTimeout);
		};
		const stop: Stop = { signal: stopper.signal, late: () => late, extend };
		void warmOne(run, connect, udid, budgetMs, stop, note).then((s) => {
			if (s.helper && late === "timeout") void discard(s.helper);
			else if (s.helper && late === "interrupt") void s.helper.close().catch(() => {});
			finish(s);
		});
	});
}

/**
 * Per device, one after the other: connect the socket helper and snapshot (retried with backoff until the
 * per-device budget is spent), so the in-sim bridge is resident before the first job. Sequential because
 * devices warming at once contend for the host: one cold bridge starves the others of CPU and pushes them
 * past their timeouts, where one at a time each gets the machine to itself. Device N+1 starts once N is warm
 * or out of budget. Each device logs to `<logDir>/warm-<worker>.log`. Failures, the timeout and an interrupt
 * only leave that device cold; this never throws. A helper that arrives after the timeout is stopped (its
 * device's jobs run cold); after an interrupt it is only disconnected, and devices not yet started are skipped.
 */
export async function warmDrivers(run: WarmRun, deps: WarmDeps): Promise<WarmOutcome> {
	const helpers: WarmHelper[] = [];
	const budgetMs = deps.timeoutMs ?? WARM_TIMEOUT_MS;
	const devices: Warmed[] = [];
	for (const device of run.devices) {
		const lines: string[] = [];
		const note = (line: string) => lines.push(`[${new Date(run.now()).toISOString()}] ${line}`);
		const log = join(run.logDir, `warm-${device.worker}.log`);
		note(`warming ${device.udid}`);
		const step = await settleDevice(run, deps.connect, device.udid, budgetMs, note);
		let warning: string | undefined;
		if (step.helper) {
			helpers.push(step.helper);
			note("snapshot ok — bridge resident");
		} else {
			note(`not warm: ${step.error}`);
			warning = `warm ${device.udid}: ${step.error} (continuing cold) — log: ${log}`;
			deps.warn?.(warning);
		}
		await run.writeFile(log, `${lines.join("\n")}\n`).catch(() => {});
		const warmed: Warmed = {
			worker: device.worker,
			udid: device.udid,
			ok: step.helper !== undefined,
			...(step.helper ? { socketPath: step.helper.socketPath } : {}),
			...(step.error !== undefined ? { error: step.error } : {}),
			...(step.axRecovery ? { axRecovery: step.axRecovery } : {}),
			log,
		};
		deps.onDevice?.(warmed, step.helper, warning);
		devices.push(warmed);
	}
	return { devices, helpers };
}
