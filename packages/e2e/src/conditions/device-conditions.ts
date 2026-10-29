import { resolve } from "node:path";
import {
	type NetworkInput,
	normalizeConditions,
	type SuiteConditions,
	toNetworkCondition,
} from "@delacour/warden-core/conditions/conditions.config";
import type {
	ClockCondition,
	HostFault,
	LatLon,
	LocationCondition,
	LocationScenario,
	NetworkCondition,
} from "@delacour/warden-core/conditions/conditions.types";
import { parseDuration } from "@delacour/warden-core/duration";
import type { Driver, DriverResult, NetworkState } from "../driver/driver.types";
import { settled, toE2eError } from "../driver/unwrap";
import type { E2eEnv } from "../env";
import { E2eError } from "../errors";
import { type ConditionEvent, type ConditionSink, openConditionSink } from "./condition-events";
import type { ConditionRecorder } from "./lease-recorder";
import { realTickerClock, type TickerClock } from "./route-ticker";
import {
	type Scheduler,
	type SchedulerOutcome,
	type SchedulerStatus,
	type SchedulerTarget,
	startFlap,
	startTimeline,
	type TimelineStep,
} from "./scheduler";

/** A duration in ms, or text like `"10s"`, `"2m"`, `"2d"`. */
export type Duration = string | number;

export type NetworkSetOptions = {
	/** iOS: relaunch the app when it runs without the warden network dylib (the default is to fail and say so) */
	relaunch?: boolean;
};

export type FlapOptions = {
	/** how long the network stays up per cycle */
	up: Duration;
	/** how long it stays down (offline) per cycle */
	down: Duration;
	/** each phase lasts its length +/- this percent, drawn from `seed` */
	jitterPct?: number;
	/** same seed, same sequence; default 1 */
	seed?: number;
	/** the "up" condition and what `stop()` puts back; default `"online"` */
	base?: NetworkInput;
};

/** A running flap or timeline. It is stopped by `stop()` and, at the latest, when the test ends. */
export type ConditionRun = {
	/** stops it (a flap puts its base back first) and resolves with how it ended */
	stop(): Promise<SchedulerOutcome>;
	/** resolves when it ended; never rejects */
	readonly done: Promise<SchedulerOutcome>;
	status(): SchedulerStatus;
};

export type NetworkStatus = {
	/** what is in effect (`flap` while one runs) */
	condition: NetworkCondition;
	faults: readonly HostFault[];
	flapping: boolean;
};

export type DeviceNetwork = {
	/**
	 * Puts the network into `condition`: `"online"`, `"offline"`, a preset (`"edge"`, `"3g"`, `"4g"`, `"lte"`,
	 * `"wifi"`, `"slow"`, `"lossy"`) or a full `NetworkCondition`. A running flap stops first. On iOS the app must
	 * run with the warden network dylib: a suite that declares `conditions.network` launches it that way, else the
	 * call fails until you pass `{ relaunch: true }`.
	 */
	set(condition: NetworkInput, options?: NetworkSetOptions): Promise<NetworkState>;
	/** Runs `fn` under `condition` and puts the previous condition (and flap) back after, also when `fn` throws. */
	during<T>(condition: NetworkInput, fn: () => Promise<T> | T, options?: NetworkSetOptions): Promise<T>;
	/** Alternates up and down until `stop()` or the end of the test; resolves once the first phase is in place. */
	flap(options: FlapOptions): Promise<ConditionRun>;
	/** Replaces the per-host faults (status, reset, delay, blackhole by host glob); `[]` clears. */
	fault(rules: HostFault | readonly HostFault[]): Promise<{ notes: readonly string[] }>;
	status(): Promise<NetworkStatus>;
	/** Stops a flap, clears the faults and returns to the suite's `conditions.network` (online when it has none). */
	reset(): Promise<void>;
};

export type LocationPoint = { lat: number; lon: number; altM?: number };
export type RouteOptions = { speedMps?: number; intervalS?: number; loop?: boolean };

export type DeviceLocation = {
	set(point: LocationPoint): Promise<void>;
	/** Plays waypoints (or a `{ gpx }` file, relative to the working directory) at `speedMps`. */
	route(points: readonly LatLon[] | { gpx: string }, options?: RouteOptions): Promise<void>;
	scenario(name: LocationScenario): Promise<void>;
	clear(): Promise<void>;
};

/** An ISO string, a `Date` or epoch milliseconds. */
export type ClockInput = string | number | Date;

export type DeviceClock = {
	/** Sets the device's wall clock; it runs on from there unless `frozen`. */
	set(at: ClockInput, options?: { frozen?: boolean }): Promise<void>;
	/** Moves the clock on by `by` (`"2d"`, or ms). */
	advance(by: Duration): Promise<void>;
	/** Runs `fn` with the clock at `at`, then puts the previous clock back, also when `fn` throws. */
	during<T>(at: ClockInput, fn: () => Promise<T> | T, options?: { frozen?: boolean }): Promise<T>;
	/** Back to the suite's `conditions.clock`, else real time. */
	reset(): Promise<void>;
	status(): ClockCondition;
};

export type TimelineStepInput = {
	/** when, from the start of the timeline */
	at: Duration;
	network?: NetworkInput;
	location?: LocationCondition | LatLon;
};

/** What the runner needs of a device's conditions; reached through {@link conditionsOf}, not on `Device`. */
export type ConditionsInternals = {
	/** the suite declares a network or clock condition, or one is active: iOS must launch with the dylib */
	wantsInject(): boolean;
	/** puts the suite's declared network, location and clock in place; warns once about areas not applied yet */
	applyBaseline(): Promise<void>;
	/** something changed or still runs: `teardown` has work to do */
	dirty(): boolean;
	/** stops flaps and timelines, and puts every area this device changed back to the baseline */
	teardown(): Promise<void>;
	/** the suite declares something to apply */
	readonly declared: boolean;
};

export type DeviceConditions = {
	network: DeviceNetwork;
	location: DeviceLocation;
	clock: DeviceClock;
	timeline(steps: readonly TimelineStepInput[]): Promise<ConditionRun>;
	internals: ConditionsInternals;
};

export type DeviceConditionsDeps = {
	driver: Driver;
	env: E2eEnv;
	/** the running attempt's signal, read per call */
	signal: () => AbortSignal | undefined;
	/** where condition events go (`results.jsonl`); default none */
	sink?: ConditionSink;
	/** time for flaps, timelines and event stamps */
	tickerClock?: TickerClock;
	/** notes (a restore that failed, areas not applied yet); default stderr */
	log?: (line: string) => void;
	/** where changes are written on the device's lease so release can undo them after a crash; default none */
	recorder?: ConditionRecorder;
};

type ConditionChange = ConditionEvent extends infer E
	? E extends ConditionEvent
		? Omit<E, "type" | "at">
		: never
	: never;

const ONLINE: NetworkCondition = { kind: "online" };
const REAL_CLOCK: ClockCondition = { kind: "real" };

const warnedAboutEnv = new WeakSet<E2eEnv>();

const stderrLog = (line: string): void => {
	process.stderr.write(`${line}\n`);
};

function invalid(message: string): E2eError {
	return new E2eError("INVALID_ARGUMENT", message);
}

function durationMs(value: Duration, what: string): number {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value < 0) throw invalid(`${what} must be 0 or more, got ${String(value)}`);
		return value;
	}
	const parsed = parseDuration(value);
	if (!parsed.success) throw invalid(`${what}: ${parsed.error}`);
	return parsed.data;
}

function network(input: NetworkInput): NetworkCondition {
	const condition = toNetworkCondition(input);
	if (!condition.success) throw invalid(condition.error);
	return condition.data;
}

function instant(at: ClockInput): Date {
	const date = at instanceof Date ? new Date(at.getTime()) : new Date(at);
	if (Number.isNaN(date.getTime()))
		throw invalid(`invalid time ${JSON.stringify(at)} (use an ISO 8601 string, a Date or epoch ms)`);
	return date;
}

function validatePoint(point: { lat: number; lon: number }): void {
	const ok =
		Number.isFinite(point.lat) && Number.isFinite(point.lon) && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
	if (!ok) throw invalid(`invalid location ${point.lat},${point.lon} (lat within 90, lon within 180)`);
}

const SCENARIOS: readonly LocationScenario[] = ["city-run", "city-bike", "freeway"];

function locationOf(input: LocationCondition | LatLon): LocationCondition {
	if ("kind" in input) return input;
	validatePoint(input);
	return { kind: "point", lat: input.lat, lon: input.lon };
}

const registry = new WeakMap<object, ConditionsInternals>();

/** Ties a device (or a wrapper of it) to its conditions' runner hooks; `Device` itself does not expose them. */
export function registerConditions(device: object, internals: ConditionsInternals): void {
	registry.set(device, internals);
}

/** The runner hooks of a device made by `createDevice` (or a `traceDevice` wrapper of one). */
export function conditionsOf(device: object): ConditionsInternals | undefined {
	return registry.get(device);
}

/** The condition sink for a session: events append to its `results.jsonl`; none without one. */
export function conditionSinkFor(session: { results?: { path: string } }): ConditionSink | undefined {
	return session.results === undefined ? undefined : openConditionSink(session.results.path);
}

export function createDeviceConditions(deps: DeviceConditionsDeps): DeviceConditions {
	const { driver, env } = deps;
	const ticker = deps.tickerClock ?? realTickerClock;
	const log = deps.log ?? stderrLog;
	const normalized = normalizeConditions(env.conditions ?? {});
	if (!normalized.success) throw new E2eError("SESSION", `invalid conditions: ${normalized.error}`);
	const baseline: SuiteConditions = normalized.data.conditions;

	let currentNetwork: NetworkCondition = ONLINE;
	let currentFaults: readonly HostFault[] = [];
	let currentClock: ClockCondition = REAL_CLOCK;
	/** when `currentClock` was set: a fixed clock has run on since */
	let clockSetAt = ticker.now();
	let networkDirty = false;
	let locationDirty = false;
	let clockDirty = false;
	let flap: { run: ConditionRun; options: FlapOptions } | undefined;
	const runs = new Set<ConditionRun>();

	const recorder = deps.recorder;

	const emit = (event: ConditionChange): void => {
		deps.sink?.({ ...event, type: "condition", at: ticker.now() });
	};

	/** One driver call: raced against the attempt's signal, a failure thrown as an `E2eError`. */
	async function call<T>(what: string, run: () => DriverResult<T>): Promise<T> {
		const result = await settled(run, what, deps.signal());
		if (result.success) return result.data;
		const error = toE2eError(result.error, what);
		if (result.error.code === "E_NETWORK_RELAUNCH") {
			throw new E2eError(
				error.code,
				`${error.message}\nthe app runs without the warden network dylib: declare \`conditions.network\` for the suite so it launches with it, or pass { relaunch: true }`
			);
		}
		throw error;
	}

	/** a flap or timeline step that landed is on the lease too: a crash mid-flap can be undone */
	const target = (options?: NetworkSetOptions): SchedulerTarget => ({
		network: async (condition) => {
			const result = await driver.network(
				condition,
				options?.relaunch === undefined ? undefined : { relaunch: options.relaunch }
			);
			if (result.success) recorder?.record("network", condition);
			return result;
		},
		location: async (op) => {
			const result = await driver.location(op);
			if (result.success) recorder?.record("location", op);
			return result;
		},
	});

	function track(scheduler: Scheduler): ConditionRun {
		const run: ConditionRun = {
			async stop() {
				scheduler.stop();
				const outcome = await scheduler.done;
				runs.delete(run);
				if (flap?.run === run) flap = undefined;
				return outcome;
			},
			done: scheduler.done,
			status: () => scheduler.current(),
		};
		runs.add(run);
		return run;
	}

	async function stopFlap(): Promise<void> {
		const running = flap;
		if (running === undefined) return;
		await running.run.stop();
	}

	async function applyNetwork(condition: NetworkCondition, options?: NetworkSetOptions): Promise<NetworkState> {
		await stopFlap();
		networkDirty = true;
		const opts = options?.relaunch === undefined ? undefined : { relaunch: options.relaunch };
		const state = await call("network", () => driver.network(condition, opts));
		currentNetwork = condition;
		recorder?.record("network", condition);
		emit({ area: "network", value: condition });
		return state;
	}

	async function startFlapRun(options: FlapOptions, netOptions?: NetworkSetOptions): Promise<ConditionRun> {
		const upMs = durationMs(options.up, "flap up");
		const downMs = durationMs(options.down, "flap down");
		if (!(upMs > 0 && downMs > 0)) throw invalid("flap needs up and down above 0");
		const base = options.base === undefined ? ONLINE : network(options.base);
		if (base.kind === "flap") throw invalid("flap base cannot itself be a flap");
		await applyNetwork(base, netOptions);
		const scheduler = startFlap(
			target(netOptions),
			{
				upMs,
				downMs,
				base,
				applyInitial: false,
				...(options.jitterPct === undefined ? {} : { jitterPct: options.jitterPct }),
				...(options.seed === undefined ? {} : { seed: options.seed }),
			},
			{ ...ticker, ...(deps.sink === undefined ? {} : { sink: deps.sink }) }
		);
		const run = track(scheduler);
		flap = { run, options };
		currentNetwork = {
			kind: "flap",
			upMs,
			downMs,
			base,
			...(options.jitterPct === undefined ? {} : { jitterPct: options.jitterPct }),
		};
		emit({ area: "network", value: currentNetwork });
		return run;
	}

	async function setNetwork(input: NetworkInput, options?: NetworkSetOptions): Promise<NetworkState> {
		const condition = network(input);
		if (condition.kind === "flap") {
			await startFlapRun(
				{
					up: condition.upMs,
					down: condition.downMs,
					...(condition.jitterPct === undefined ? {} : { jitterPct: condition.jitterPct }),
					...(condition.base === undefined ? {} : { base: condition.base }),
				},
				options
			);
			return { online: true, condition, needsProxy: [] };
		}
		return applyNetwork(condition, options);
	}

	async function restoreNetwork(
		previous: NetworkCondition,
		previousFlap: FlapOptions | undefined,
		options?: NetworkSetOptions
	): Promise<void> {
		if (previous.kind === "flap" && previousFlap !== undefined) await startFlapRun(previousFlap, options);
		else await applyNetwork(previous, options);
	}

	async function resetNetwork(): Promise<void> {
		await stopFlap();
		if (currentFaults.length > 0) await setFaults([]);
		const goal = baseline.network ?? ONLINE;
		await applyNetwork(goal);
		networkDirty = false;
		recorder?.settle("network", goal, goal.kind === "online");
	}

	async function setFaults(rules: readonly HostFault[]): Promise<{ notes: readonly string[] }> {
		networkDirty = true;
		const result = await call("network faults", () => driver.networkFaults(rules));
		currentFaults = rules;
		recorder?.record("network", currentNetwork);
		emit({ area: "faults", value: { kind: "faults", rules } });
		return result;
	}

	const networkApi: DeviceNetwork = {
		set: setNetwork,
		async during(condition, fn, options) {
			const previous = currentNetwork;
			const previousFlap = flap?.options;
			await setNetwork(condition, options);
			let result: Awaited<ReturnType<typeof fn>>;
			try {
				result = await fn();
			} catch (error) {
				await restoreNetwork(previous, previousFlap, options).catch((restoreError: unknown) =>
					log(
						`[warden-e2e] network.during: restoring the previous network failed: ${String(restoreError instanceof Error ? restoreError.message : restoreError)}`
					)
				);
				throw error;
			}
			await restoreNetwork(previous, previousFlap, options);
			return result;
		},
		flap: (options) => startFlapRun(options),
		fault: (rules) => setFaults("match" in rules ? [rules] : rules),
		async status() {
			return { condition: currentNetwork, faults: currentFaults, flapping: flap !== undefined };
		},
		reset: resetNetwork,
	};

	async function applyLocation(op: LocationCondition): Promise<void> {
		locationDirty = true;
		await call("location", () => driver.location(op));
		recorder?.record("location", op);
		emit({ area: "location", value: op });
	}

	const locationApi: DeviceLocation = {
		async set(point) {
			validatePoint(point);
			await applyLocation({
				kind: "point",
				lat: point.lat,
				lon: point.lon,
				...(point.altM === undefined ? {} : { altM: point.altM }),
			});
		},
		async route(points, options = {}) {
			const pace = {
				...(options.speedMps === undefined ? {} : { speedMps: options.speedMps }),
			};
			if ("gpx" in points) {
				await applyLocation({ kind: "gpx", path: resolve(points.gpx), ...pace });
				return;
			}
			if (points.length === 0) throw invalid("a route needs at least one point");
			for (const point of points) validatePoint(point);
			await applyLocation({
				kind: "route",
				points,
				...pace,
				...(options.intervalS === undefined ? {} : { intervalS: options.intervalS }),
				...(options.loop === undefined ? {} : { loop: options.loop }),
			});
		},
		async scenario(name) {
			if (!SCENARIOS.includes(name)) throw invalid(`unknown scenario "${String(name)}" (use ${SCENARIOS.join(", ")})`);
			await applyLocation({ kind: "scenario", name });
		},
		clear: () => applyLocation({ kind: "clear" }),
	};

	async function applyClock(condition: ClockCondition): Promise<void> {
		// a remote driver offers only the ops its server has, so `clock` can be missing at runtime
		const op: Driver["clock"] | undefined = driver.clock;
		clockDirty = true;
		if (typeof op !== "function") {
			throw toE2eError(
				{ code: "E_UNSUPPORTED", message: "this driver has no clock condition", retryable: false },
				"clock"
			);
		}
		await call("clock", () => op.call(driver, condition));
		currentClock = condition;
		clockSetAt = ticker.now();
		emit({ area: "clock", value: condition });
	}

	function clockFor(at: ClockInput, frozen: boolean | undefined): ClockCondition {
		const iso = instant(at).toISOString();
		return frozen === true ? { kind: "frozen", at: iso } : { kind: "fixed", at: iso };
	}

	function advanced(by: number): ClockCondition {
		switch (currentClock.kind) {
			case "real":
				return { kind: "offset", ms: by };
			case "offset":
				return { kind: "offset", ms: currentClock.ms + by };
			case "frozen":
				return { kind: "frozen", at: new Date(Date.parse(currentClock.at) + by).toISOString() };
			case "fixed": {
				const now = Date.parse(currentClock.at) + (ticker.now() - clockSetAt);
				return { kind: "fixed", at: new Date(now + by).toISOString() };
			}
		}
	}

	const clockApi: DeviceClock = {
		async set(at, options) {
			await applyClock(clockFor(at, options?.frozen));
		},
		async advance(by) {
			await applyClock(advanced(durationMs(by, "advance")));
		},
		async during(at, fn, options) {
			const previous = currentClock;
			await applyClock(clockFor(at, options?.frozen));
			let result: Awaited<ReturnType<typeof fn>>;
			try {
				result = await fn();
			} catch (error) {
				await applyClock(previous).catch((restoreError: unknown) =>
					log(
						`[warden-e2e] clock.during: restoring the previous clock failed: ${String(restoreError instanceof Error ? restoreError.message : restoreError)}`
					)
				);
				throw error;
			}
			await applyClock(previous);
			return result;
		},
		async reset() {
			await applyClock(baseline.clock ?? REAL_CLOCK);
			clockDirty = false;
		},
		status: () => currentClock,
	};

	async function startTimelineRun(steps: readonly TimelineStepInput[]): Promise<ConditionRun> {
		const converted: TimelineStep[] = steps.map((step, index) => {
			const atMs = durationMs(step.at, `timeline step ${index} at`);
			const converted: TimelineStep = { atMs };
			if (step.network !== undefined) {
				const condition = network(step.network);
				if (condition.kind === "flap") throw invalid(`timeline step ${index}: use device.network.flap for a flap`);
				converted.network = condition;
			}
			if (step.location !== undefined) converted.location = locationOf(step.location);
			return converted;
		});
		networkDirty = true;
		locationDirty = true;
		const scheduler = startTimeline(target(), converted, {
			...ticker,
			...(deps.sink === undefined ? {} : { sink: deps.sink }),
		});
		const status = scheduler.current();
		if (status.state === "failed") throw invalid(status.error);
		const run = track(scheduler);
		const last = converted.at(-1);
		if (last?.network !== undefined) currentNetwork = last.network;
		return run;
	}

	async function stopRuns(): Promise<void> {
		const failures: string[] = [];
		for (const run of [...runs]) {
			const outcome = await run.stop();
			if (outcome.stopped === "failed") failures.push(outcome.error);
		}
		if (failures.length > 0) {
			throw new E2eError(
				"ACTION_FAILED",
				`a network flap or timeline stopped on its own after failing: ${failures[0]}`
			);
		}
	}

	const declared = baseline.network !== undefined || baseline.location !== undefined || baseline.clock !== undefined;

	const internals: ConditionsInternals = {
		declared,
		dirty: () => networkDirty || locationDirty || clockDirty || runs.size > 0,
		wantsInject: () =>
			baseline.network !== undefined ||
			baseline.clock !== undefined ||
			currentNetwork.kind !== "online" ||
			currentClock.kind !== "real",
		async applyBaseline() {
			if (normalized.data.unapplied.length > 0 && !warnedAboutEnv.has(env)) {
				warnedAboutEnv.add(env);
				log(
					`[warden-e2e] conditions: ${normalized.data.unapplied.join(", ")} not applied yet (only network, location and clock are)`
				);
			}
			if (baseline.clock !== undefined) await applyClock(baseline.clock);
			if (baseline.location !== undefined) await applyLocation(baseline.location);
			if (baseline.network !== undefined) await applyNetwork(baseline.network, { relaunch: true });
			networkDirty = false;
			locationDirty = false;
			clockDirty = false;
		},
		async teardown() {
			const errors: unknown[] = [];
			const attempt = async (run: () => Promise<void>): Promise<void> => {
				try {
					await run();
				} catch (error) {
					errors.push(error);
				}
			};
			await attempt(stopRuns);
			if (networkDirty) await attempt(resetNetwork);
			if (locationDirty) {
				await attempt(async () => {
					const goal = baseline.location ?? { kind: "clear" };
					await applyLocation(goal);
					locationDirty = false;
					recorder?.settle("location", goal, goal.kind === "clear");
				});
			}
			if (clockDirty) await attempt(clockApi.reset);
			if (errors.length > 0) throw errors[0];
		},
	};

	return { network: networkApi, location: locationApi, clock: clockApi, timeline: startTimelineRun, internals };
}
