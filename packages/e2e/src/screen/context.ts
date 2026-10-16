import type { DevtoolsFacet } from "../devtools/devtools.types";
import type { Driver, DriverError, DriverResult, Snapshot } from "../driver/driver.types";
import { canDetectAlerts, canObserve } from "../driver/observation-cache";
import { DEFAULT_ASSERTION_TIMEOUT_MS } from "../env";
import { E2eError } from "../errors";
import type { SpanOptions, SpanRunner } from "../runner/span";
import { indexSnapshot, type NodeIndex } from "./nodes";
import { type Clock, type PollResult, type PollStep, poll, systemClock } from "./poll";
import { locateByTestIdViaReact, type ReactMatch } from "./react-locator";
import { renderHeader, renderSnapshot } from "./render";
import type { TextMatch } from "./text";

/**
 * What `screen` and `Locator` need from the test session. `Session` satisfies it as is; the optional members are
 * filled in by the test wrapper when it exists (feature-detected, so queries work under a bare session too).
 */
export type ScreenHost = {
	driver(): Promise<Driver>;
	env: { actionTimeoutMs: number; assertionTimeoutMs?: number };
	/** live override of the action timeout (`test.use({ actionTimeout })`) */
	actionTimeout?: () => number;
	/** live override of the assertion timeout (`test.use({ assertionTimeout })`) */
	assertionTimeout?: () => number;
	/** the running attempt's deadline: every poll stops when it aborts */
	signal?: AbortSignal;
	/** records one reported step around an action */
	step?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
	/** times a read (`read.isVisible`, …) as a trace-only `span`; absent = reads are not traced */
	span?: SpanRunner;
	/** polling time source; tests inject a fake */
	clock?: Clock;
	/**
	 * The running app's devtools, when there is one (a dev client with Metro). `getByTestId` falls back to the React
	 * component tree through it when the accessibility tree has no such node.
	 */
	devtools?: () => Pick<DevtoolsFacet, "tree"> | undefined;
	/**
	 * `test.use({ systemAlerts })`: answers the alert or sheet on top the way that option says (`device.alert("accept")`
	 * or `("dismiss")`) and resolves false when none could be answered. Reads and waits call it when the snapshot they
	 * already took shows one, so a screen without an alert costs nothing. Absent = alerts are left alone.
	 */
	answerSystemAlert?: () => Promise<boolean>;
};

export type Observed = { driver: Driver; snapshot: Snapshot; index: NodeIndex };

export type Observation = { ok: true; observed: Observed } | { ok: false; error: DriverError };

/** Lines of the accessibility tree attached to a failure. */
const EXCERPT_LINES = 40;
/** One look at the screen answers at most this many alerts (a sheet that stays up is not pressed forever). */
const MAX_ALERT_ANSWERS = 3;
/** The React tree is read at most this often while a locator polls. */
const REACT_THROTTLE_MS = 450;
/** One React tree read gives up after this long, so a stuck page cannot eat the action timeout. */
const REACT_TIMEOUT_MS = 2000;

/** What a look at the screen may do beyond reading it. */
export type ObserveOptions = {
	/**
	 * May answer with the snapshot the last read kept (`driver/observation-cache.ts`: nothing was pressed since and it is
	 * young). Only the first poll of a wait asks for it; a later one reads the device, or a wait could spin on a tree
	 * that stopped being true. Default: no.
	 */
	reuse?: boolean;
	/** Answer a system alert the snapshot shows when `test.use({ systemAlerts })` says to. Default: yes. */
	alerts?: boolean;
};

export class Runtime {
	private reactCache: { key: string; at: number; matches: ReactMatch[] } | undefined;
	/** the index of each snapshot, so a snapshot that several reads share is indexed once */
	private readonly indexed = new WeakMap<Snapshot, NodeIndex>();

	constructor(readonly host: ScreenHost) {}

	get clock(): Clock {
		return this.host.clock ?? systemClock;
	}

	actionTimeout(): number {
		return this.host.actionTimeout?.() ?? this.host.env.actionTimeoutMs;
	}

	assertionTimeout(): number {
		return this.host.assertionTimeout?.() ?? this.host.env.assertionTimeoutMs ?? DEFAULT_ASSERTION_TIMEOUT_MS;
	}

	/** A deadline `timeoutMs` (default: the action timeout) from now; `remaining()` is what is left of it. */
	budget(timeoutMs?: number): { remaining(): number; total: number } {
		const total = timeoutMs ?? this.actionTimeout();
		const deadline = this.clock.now() + total;
		return { remaining: () => Math.max(0, deadline - this.clock.now()), total };
	}

	step<T>(label: string, fn: () => Promise<T>): Promise<T> {
		return this.host.step === undefined ? fn() : this.host.step(label, fn);
	}

	span<T>(op: string, fn: () => Promise<T>, options?: SpanOptions<T>): Promise<T> {
		return this.host.span === undefined ? fn() : this.host.span(op, fn, options);
	}

	private indexOf(snapshot: Snapshot): NodeIndex {
		const known = this.indexed.get(snapshot);
		if (known !== undefined) return known;
		const index = indexSnapshot(snapshot);
		this.indexed.set(snapshot, index);
		return index;
	}

	/**
	 * One look at the device, indexed. A driver failure comes back as data so callers can retry the retryable. With
	 * `systemAlerts` on, an alert the screen shows is answered and the screen looked at again.
	 */
	async tryObserve(options: ObserveOptions = {}): Promise<Observation> {
		const driver = await this.host.driver();
		let reuse = options.reuse === true;
		for (let answered = 0; ; answered += 1) {
			const result = canObserve(driver) ? await driver.observe({ reuse }) : await driver.snapshot();
			if (!result.success) return { ok: false, error: result.error };
			const observation: Observation = {
				ok: true,
				observed: { driver, snapshot: result.data, index: this.indexOf(result.data) },
			};
			if (options.alerts === false || answered >= MAX_ALERT_ANSWERS) return observation;
			if (!(await this.answeredAlert(driver, result.data))) return observation;
			reuse = false;
		}
	}

	/** Whether `snapshot` showed an alert that has now been answered. A screen without one costs no extra read. */
	private async answeredAlert(driver: Driver, snapshot: Snapshot): Promise<boolean> {
		const answer = this.host.answerSystemAlert;
		if (answer === undefined) return false;
		const shown = snapshot.modal !== undefined || (canDetectAlerts(driver) && driver.alertIn(snapshot) !== null);
		return shown && (await answer());
	}

	/** Forgets the snapshot the last read kept: the next look reads the device. For a wait that makes its own reads between polls. */
	async forgetObservation(): Promise<void> {
		const driver = await this.host.driver();
		if (canObserve(driver)) driver.invalidateObservations();
	}

	/**
	 * Like `tryObserve`, but a driver failure is thrown. Retryable failures (a busy accessibility service, a stale
	 * helper) are retried within the action timeout first. The first look may reuse a kept snapshot (`reuse: false`
	 * opts out); the retries never do.
	 */
	async observe(options: { reuse?: boolean } = {}): Promise<Observed> {
		const reuse = options.reuse ?? true;
		const result = await this.poll<Observed, DriverError>(async (attempt) => {
			const observation = await this.tryObserve({ reuse: reuse && attempt === 1 });
			if (observation.ok) return { done: true, value: observation.observed };
			if (!observation.error.retryable) throw driverFailure("snapshot", observation.error);
			return { done: false, state: observation.error };
		}, this.actionTimeout());
		if (result.status === "done") return result.value;
		throw driverFailure("snapshot", result.last ?? { code: "E_TIMEOUT", message: "no snapshot", retryable: true });
	}

	/**
	 * Components of the React tree whose testID matches, for `getByTestId` when the accessibility tree has none.
	 * Empty without devtools. Reads are throttled: inside the window the previous answer for the same query is reused.
	 */
	async reactMatches(testId: TextMatch, observed: Observed): Promise<ReactMatch[]> {
		const facet = this.host.devtools?.();
		if (facet === undefined) return [];
		const key = typeof testId === "string" ? `s:${testId}` : `r:${testId.toString()}`;
		const cached = this.reactCache;
		if (cached !== undefined && cached.key === key && this.clock.now() - cached.at < REACT_THROTTLE_MS) {
			return cached.matches;
		}
		const view = { platform: observed.snapshot.platform, screen: observed.snapshot.screen };
		const matches = await locateByTestIdViaReact(facet, testId, view, { timeoutMs: REACT_TIMEOUT_MS });
		this.reactCache = { key, at: this.clock.now(), matches };
		return matches;
	}

	/**
	 * The interactive part of the tree as text, for failure messages. It indexes the snapshot again and renders up to
	 * `EXCERPT_LINES` lines, so call it only once an error is certain; keep the snapshot, not this text, while polling.
	 */
	excerpt(snapshot: Snapshot): string {
		const rendered = renderSnapshot(snapshot, { interactiveOnly: true, refs: new Map(), maxLines: EXCERPT_LINES });
		return [renderHeader({ snapshot, rendered, interactiveOnly: true }), ...rendered.lines].join("\n");
	}

	/**
	 * `poll` on this runtime's clock and abort signal; an abort throws instead of returning. `intervalMs` is a fixed gap
	 * between attempts instead of the back-off schedule.
	 */
	async poll<T, S>(
		step: (attempt: number) => Promise<PollStep<T, S>> | PollStep<T, S>,
		timeoutMs: number,
		options: { intervalMs?: number } = {}
	): Promise<Exclude<PollResult<T, S>, { status: "aborted" }>> {
		const signal = this.host.signal;
		const result = await poll(step, {
			timeoutMs,
			...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
			...(signal === undefined ? {} : { signal }),
			now: this.clock.now,
			sleep: this.clock.sleep,
		});
		if (result.status === "aborted") throw abortError(signal);
		return result;
	}

	/** Unwraps a driver call made for an action; a failure becomes `ACTION_FAILED` naming the driver's code. */
	drive<T>(verb: string, result: Awaited<DriverResult<T>>): T {
		if (!result.success) throw driverFailure(verb, result.error, "ACTION_FAILED");
		return result.data;
	}
}

export function driverFailure(verb: string, error: DriverError, code: "DRIVER" | "ACTION_FAILED" = "DRIVER"): E2eError {
	return new E2eError(code, `${verb} failed: ${error.code}: ${error.message}`);
}

function abortError(signal: AbortSignal | undefined): E2eError {
	const reason: unknown = signal?.reason;
	if (reason instanceof E2eError) return reason;
	return new E2eError("TIMEOUT", "the test was aborted before the action finished");
}
