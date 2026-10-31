import type { LocationCondition, NetworkCondition } from "@delacour/warden-core/conditions/conditions.types";
import type { ConditionSink } from "./condition-events";
import type { TickerClock } from "./route-ticker";

const MAX_CONSECUTIVE_FAILURES = 3;
const ONLINE: NetworkCondition = { kind: "online" };
const OFFLINE: NetworkCondition = { kind: "offline" };

export type StepResult = { success: true } | { success: false; error: { message: string } };

/** The slice of a `Driver` the scheduler drives. A driver satisfies it; the detached child builds a smaller one. */
export type SchedulerTarget = {
	network?(condition: NetworkCondition): Promise<StepResult>;
	location?(op: LocationCondition): Promise<StepResult>;
};

export type SchedulerDeps = TickerClock & {
	/** uniform [0, 1) for jitter; default is a generator seeded from `seed` */
	rng?: () => number;
	/** told about every transition that landed */
	sink?: ConditionSink;
};

export type FlapOptions = {
	upMs: number;
	downMs: number;
	/** each phase lasts its length +/- this percent, drawn from the seeded rng */
	jitterPct?: number;
	/** the "up" condition, default online; also what stop restores */
	base?: NetworkCondition;
	seed?: number;
	/** false when the caller already put the device in `base`; the first phase then just waits */
	applyInitial?: boolean;
};

export type TimelineStep = { atMs: number; network?: NetworkCondition; location?: LocationCondition };

export type SchedulerOutcome =
	| { transitions: number; stopped: "finished" | "aborted" }
	| { transitions: number; stopped: "failed"; error: string };

export type SchedulerStatus =
	| { state: "running"; transitions: number; phase?: "up" | "down"; step?: number }
	| { state: "finished" | "stopped"; transitions: number }
	| { state: "failed"; transitions: number; error: string };

export type Scheduler = {
	/** idempotent; flap puts `base` back before `done` resolves, a timeline just stops */
	stop(): void;
	/** resolves with the outcome, never rejects */
	done: Promise<SchedulerOutcome>;
	current(): SchedulerStatus;
};

/** mulberry32: small, fast, and the same sequence for the same seed. */
export function seededRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Run one apply; a rejection is a failure like any other. */
async function attempt(run: (() => Promise<StepResult>) | undefined, what: string): Promise<string | undefined> {
	if (!run) return `target cannot apply ${what}`;
	try {
		const res = await run();
		return res.success ? undefined : res.error.message;
	} catch (e) {
		return messageOf(e);
	}
}

type Core = {
	signal: AbortSignal;
	controller: AbortController;
	status: SchedulerStatus;
	transitions: number;
};

function core(): Core {
	const controller = new AbortController();
	return { controller, signal: controller.signal, status: { state: "running", transitions: 0 }, transitions: 0 };
}

function invalid(message: string): Scheduler {
	return {
		stop: () => undefined,
		done: Promise.resolve({ transitions: 0, stopped: "failed", error: message }),
		current: () => ({ state: "failed", transitions: 0, error: message }),
	};
}

/** Settle the status and build the outcome; `error` makes it a failure. */
function conclude(state: Core, end: "finished" | "aborted", error?: string): SchedulerOutcome {
	const { transitions } = state;
	if (error !== undefined) {
		state.status = { state: "failed", transitions, error };
		return { transitions, stopped: "failed", error };
	}
	state.status = { state: end === "finished" ? "finished" : "stopped", transitions };
	return { transitions, stopped: end };
}

/** Applies conditions to the target, counting the ones that landed and the failures in a row. */
function applier(target: SchedulerTarget, deps: SchedulerDeps, state: Core) {
	const net = target.network?.bind(target);
	const loc = target.location?.bind(target);
	const tally = { failures: 0, lastError: "" };
	const record = async (run: (() => Promise<StepResult>) | undefined, what: string): Promise<boolean> => {
		const failure = await attempt(run, what);
		if (failure) {
			tally.failures++;
			tally.lastError = failure;
			return false;
		}
		tally.failures = 0;
		state.transitions++;
		return true;
	};
	return {
		tally,
		async network(condition: NetworkCondition): Promise<boolean> {
			const landed = await record(net && (() => net(condition)), "network");
			if (landed) deps.sink?.({ type: "condition", area: "network", value: condition, at: deps.now() });
			return landed;
		},
		async location(op: LocationCondition): Promise<boolean> {
			const landed = await record(loc && (() => loc(op)), "location");
			if (landed) deps.sink?.({ type: "condition", area: "location", value: op, at: deps.now() });
			return landed;
		},
	};
}

/**
 * Alternates the network between `base` (up, `upMs`) and offline (down, `downMs`), each phase stretched or
 * shrunk by up to `jitterPct` using a seeded rng, paced against the clock. Starts in the up phase. In this
 * process: the driver holds the handle and stops it on the next network op or `close()`; a detached child runs
 * the same loop (`scheduler.main.ts`). 3 failed transitions in a row end it as `failed`. However it ends, `base`
 * is put back before `done` resolves (best effort when it ended on a failure).
 */
export function startFlap(target: SchedulerTarget, options: FlapOptions, deps: SchedulerDeps): Scheduler {
	if (!(options.upMs > 0 && options.downMs > 0 && Number.isFinite(options.upMs + options.downMs))) {
		return invalid("flap needs upMs and downMs above 0");
	}
	if (options.base?.kind === "flap") return invalid("flap base cannot itself be a flap");
	const base = options.base ?? ONLINE;
	const rng = deps.rng ?? seededRng(options.seed ?? 1);
	const jitter = (options.jitterPct ?? 0) / 100;
	const state = core();
	const { signal } = state;
	const apply = applier(target, deps, state);
	const stretch = (ms: number): number => Math.max(1, ms * (1 + (rng() * 2 - 1) * jitter));

	/** One phase: put the device in it (unless the caller already did), then wait it out. Returns whether base is active. */
	const runPhase = async (phase: "up" | "down", skipApply: boolean, deadline: number): Promise<[boolean, number]> => {
		const landed = skipApply || (await apply.network(phase === "up" ? base : OFFLINE));
		state.status = { state: "running", transitions: state.transitions, phase };
		const next = deadline + stretch(phase === "up" ? options.upMs : options.downMs);
		await deps.sleep(Math.max(0, next - deps.now()), signal);
		return [landed && phase === "up", next];
	};

	const run = async (): Promise<SchedulerOutcome> => {
		let phase: "up" | "down" = "up";
		let atBase = false;
		let deadline = deps.now();
		let skipApply = options.applyInitial === false;
		while (!signal.aborted && apply.tally.failures < MAX_CONSECUTIVE_FAILURES) {
			[atBase, deadline] = await runPhase(phase, skipApply, deadline);
			skipApply = false;
			phase = phase === "up" ? "down" : "up";
		}
		const { failures, lastError } = apply.tally;
		if (!atBase) await apply.network(base);
		return conclude(state, "aborted", failures >= MAX_CONSECUTIVE_FAILURES ? lastError : undefined);
	};

	return { stop: () => state.controller.abort(), done: run(), current: () => state.status };
}

/**
 * Runs `steps` in `atMs` order (ties keep the given order), each at `atMs` after the start, paced against the
 * clock. A step with both `network` and `location` applies the network first, then the location. A step counts
 * as failed when either part fails; 3 failed steps in a row end it as `failed`. Stopping leaves the device as
 * the last step left it (restoring is the spec API's job: it knows the previous conditions).
 */
export function startTimeline(target: SchedulerTarget, steps: readonly TimelineStep[], deps: SchedulerDeps): Scheduler {
	if (steps.some((s) => !(s.atMs >= 0) || !Number.isFinite(s.atMs))) return invalid("timeline atMs must be 0 or more");
	const ordered = [...steps].sort((a, b) => a.atMs - b.atMs);
	const startedAt = deps.now();
	const state = core();
	const { signal } = state;
	const apply = applier(target, deps, state);

	/** Both parts always run; the problem is every part's failure, or nothing when all landed. */
	const runStep = async (step: TimelineStep): Promise<string | undefined> => {
		const errors: string[] = [];
		if (step.network && !(await apply.network(step.network))) errors.push(apply.tally.lastError);
		if (step.location && !(await apply.location(step.location))) errors.push(apply.tally.lastError);
		return errors.length > 0 ? errors.join("; ") : undefined;
	};

	const run = async (): Promise<SchedulerOutcome> => {
		let stepFailures = 0;
		let lastError = "";
		for (const [index, step] of ordered.entries()) {
			await deps.sleep(Math.max(0, startedAt + step.atMs - deps.now()), signal);
			if (signal.aborted) break;
			state.status = { state: "running", transitions: state.transitions, step: index };
			const problem = await runStep(step);
			stepFailures = problem === undefined ? 0 : stepFailures + 1;
			lastError = problem ?? lastError;
			if (stepFailures >= MAX_CONSECUTIVE_FAILURES) return conclude(state, "aborted", lastError);
		}
		return conclude(state, signal.aborted ? "aborted" : "finished");
	};

	return { stop: () => state.controller.abort(), done: run(), current: () => state.status };
}
