import type { LocationCondition, NetworkCondition } from "@delacour/warden-config/conditions.types";
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

/** Shared state of one scheduler run: abort control, status, and the applier that counts landed transitions. */
class SchedulerCore {
	readonly controller = new AbortController();
	status: SchedulerStatus = { state: "running", transitions: 0 };
	transitions = 0;
	readonly tally = { failures: 0, lastError: "" };
	private readonly net: SchedulerTarget["network"];
	private readonly loc: SchedulerTarget["location"];

	constructor(
		target: SchedulerTarget,
		private readonly deps: SchedulerDeps
	) {
		this.net = target.network?.bind(target);
		this.loc = target.location?.bind(target);
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	handle(done: Promise<SchedulerOutcome>): Scheduler {
		return { stop: () => this.controller.abort(), done, current: () => this.status };
	}

	async network(condition: NetworkCondition): Promise<boolean> {
		const { net } = this;
		const landed = await this.record(net && (() => net(condition)), "network");
		if (landed) this.deps.sink?.({ type: "condition", area: "network", value: condition, at: this.deps.now() });
		return landed;
	}

	async location(op: LocationCondition): Promise<boolean> {
		const { loc } = this;
		const landed = await this.record(loc && (() => loc(op)), "location");
		if (landed) this.deps.sink?.({ type: "condition", area: "location", value: op, at: this.deps.now() });
		return landed;
	}

	/** Settle the status and build the outcome; `error` makes it a failure. */
	conclude(end: "finished" | "aborted", error?: string): SchedulerOutcome {
		const { transitions } = this;
		if (error !== undefined) {
			this.status = { state: "failed", transitions, error };
			return { transitions, stopped: "failed", error };
		}
		this.status = { state: end === "finished" ? "finished" : "stopped", transitions };
		return { transitions, stopped: end };
	}

	private async record(run: (() => Promise<StepResult>) | undefined, what: string): Promise<boolean> {
		const failure = await this.attempt(run, what);
		if (failure) {
			this.tally.failures++;
			this.tally.lastError = failure;
			return false;
		}
		this.tally.failures = 0;
		this.transitions++;
		return true;
	}

	/** Run one apply; a rejection is a failure like any other. */
	private async attempt(run: (() => Promise<StepResult>) | undefined, what: string): Promise<string | undefined> {
		if (!run) return `target cannot apply ${what}`;
		try {
			const res = await run();
			return res.success ? undefined : res.error.message;
		} catch (e) {
			return e instanceof Error ? e.message : String(e);
		}
	}
}

/** One flap run: alternates the network between base and offline. */
class FlapRun {
	private readonly base: NetworkCondition;
	private readonly rng: () => number;
	private readonly jitter: number;

	constructor(
		private readonly state: SchedulerCore,
		private readonly options: FlapOptions,
		private readonly deps: SchedulerDeps,
		rng: () => number
	) {
		this.base = options.base ?? ONLINE;
		this.rng = rng;
		this.jitter = (options.jitterPct ?? 0) / 100;
	}

	start(): Scheduler {
		return this.state.handle(this.run());
	}

	private stretch(ms: number): number {
		return Math.max(1, ms * (1 + (this.rng() * 2 - 1) * this.jitter));
	}

	/** One phase: put the device in it (unless the caller already did), then wait it out. Returns whether base is active. */
	private async runPhase(phase: "up" | "down", skipApply: boolean, deadline: number): Promise<[boolean, number]> {
		const landed = skipApply || (await this.state.network(phase === "up" ? this.base : OFFLINE));
		this.state.status = { state: "running", transitions: this.state.transitions, phase };
		const next = deadline + this.stretch(phase === "up" ? this.options.upMs : this.options.downMs);
		await this.deps.sleep(Math.max(0, next - this.deps.now()), this.state.signal);
		return [landed && phase === "up", next];
	}

	private async run(): Promise<SchedulerOutcome> {
		let phase: "up" | "down" = "up";
		let atBase = false;
		let deadline = this.deps.now();
		let skipApply = this.options.applyInitial === false;
		while (!this.state.signal.aborted && this.state.tally.failures < MAX_CONSECUTIVE_FAILURES) {
			[atBase, deadline] = await this.runPhase(phase, skipApply, deadline);
			skipApply = false;
			phase = phase === "up" ? "down" : "up";
		}
		const { failures, lastError } = this.state.tally;
		if (!atBase) await this.state.network(this.base);
		return this.state.conclude("aborted", failures >= MAX_CONSECUTIVE_FAILURES ? lastError : undefined);
	}
}

/** One timeline run: applies steps at their offsets. */
class TimelineRun {
	private readonly ordered: TimelineStep[];
	private readonly startedAt: number;

	constructor(
		private readonly state: SchedulerCore,
		steps: readonly TimelineStep[],
		private readonly deps: SchedulerDeps
	) {
		this.ordered = [...steps].sort((a, b) => a.atMs - b.atMs);
		this.startedAt = deps.now();
	}

	start(): Scheduler {
		return this.state.handle(this.run());
	}

	/** Both parts always run; the problem is every part's failure, or nothing when all landed. */
	private async runStep(step: TimelineStep): Promise<string | undefined> {
		const errors: string[] = [];
		if (step.network && !(await this.state.network(step.network))) errors.push(this.state.tally.lastError);
		if (step.location && !(await this.state.location(step.location))) errors.push(this.state.tally.lastError);
		return errors.length > 0 ? errors.join("; ") : undefined;
	}

	private async run(): Promise<SchedulerOutcome> {
		const { signal } = this.state;
		let stepFailures = 0;
		let lastError = "";
		for (const [index, step] of this.ordered.entries()) {
			await this.deps.sleep(Math.max(0, this.startedAt + step.atMs - this.deps.now()), signal);
			if (signal.aborted) break;
			this.state.status = { state: "running", transitions: this.state.transitions, step: index };
			const problem = await this.runStep(step);
			stepFailures = problem === undefined ? 0 : stepFailures + 1;
			lastError = problem ?? lastError;
			if (stepFailures >= MAX_CONSECUTIVE_FAILURES) return this.state.conclude("aborted", lastError);
		}
		return this.state.conclude(signal.aborted ? "aborted" : "finished");
	}
}

/** Flap and timeline schedulers for network / location conditions. Use the shared {@link schedulers} singleton. */
export class Schedulers {
	/** mulberry32: small, fast, and the same sequence for the same seed. */
	seededRng(seed: number): () => number {
		let a = seed >>> 0;
		return () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	/**
	 * Alternates the network between `base` (up, `upMs`) and offline (down, `downMs`), each phase stretched or
	 * shrunk by up to `jitterPct` using a seeded rng, paced against the clock. Starts in the up phase. In this
	 * process: the driver holds the handle and stops it on the next network op or `close()`; a detached child runs
	 * the same loop (`scheduler.main.ts`). 3 failed transitions in a row end it as `failed`. However it ends, `base`
	 * is put back before `done` resolves (best effort when it ended on a failure).
	 */
	startFlap(target: SchedulerTarget, options: FlapOptions, deps: SchedulerDeps): Scheduler {
		if (!(options.upMs > 0 && options.downMs > 0 && Number.isFinite(options.upMs + options.downMs))) {
			return this.invalid("flap needs upMs and downMs above 0");
		}
		if (options.base?.kind === "flap") return this.invalid("flap base cannot itself be a flap");
		const rng = deps.rng ?? this.seededRng(options.seed ?? 1);
		return new FlapRun(new SchedulerCore(target, deps), options, deps, rng).start();
	}

	/**
	 * Runs `steps` in `atMs` order (ties keep the given order), each at `atMs` after the start, paced against the
	 * clock. A step with both `network` and `location` applies the network first, then the location. A step counts
	 * as failed when either part fails; 3 failed steps in a row end it as `failed`. Stopping leaves the device as
	 * the last step left it (restoring is the spec API's job: it knows the previous conditions).
	 */
	startTimeline(target: SchedulerTarget, steps: readonly TimelineStep[], deps: SchedulerDeps): Scheduler {
		if (steps.some((s) => !(s.atMs >= 0) || !Number.isFinite(s.atMs))) {
			return this.invalid("timeline atMs must be 0 or more");
		}
		return new TimelineRun(new SchedulerCore(target, deps), steps, deps).start();
	}

	private invalid(message: string): Scheduler {
		return {
			stop: () => undefined,
			done: Promise.resolve({ transitions: 0, stopped: "failed", error: message }),
			current: () => ({ state: "failed", transitions: 0, error: message }),
		};
	}
}

export const schedulers = new Schedulers();
