import { resolve } from "node:path";
import {
	type ConditionsConfig,
	conditionsConfigs,
	type NetworkInput,
	type SuiteConditions,
} from "@delacour/warden-config/conditions.config";
import type {
	A11yCondition,
	BatteryCondition,
	ClockCondition,
	HostFault,
	LatLon,
	LocaleCondition,
	LocationCondition,
	LocationScenario,
	NetworkCondition,
	PermissionCondition,
	PermissionName,
	PermissionState,
} from "@delacour/warden-config/conditions.types";
import { durationParser } from "@delacour/warden-config/duration";
import { textSizes } from "@delacour/warden-config/text-size";
import {
	type ConditionEvent,
	type ConditionSink,
	conditionEvents,
} from "@delacour/warden-driver/conditions/condition-events";
import { realTickerClock, type TickerClock } from "@delacour/warden-driver/conditions/route-ticker";
import {
	type Scheduler,
	type SchedulerOutcome,
	type SchedulerStatus,
	type SchedulerTarget,
	schedulers,
	type TimelineStep,
} from "@delacour/warden-driver/conditions/scheduler";
import type {
	A11yOp,
	A11yState,
	BatteryOp,
	BatteryState,
	Driver,
	DriverResult,
	LocaleState,
	NetworkState,
	PermissionGrants,
	PermissionsState,
	PushPayload,
	SettingOptions,
	TimezoneState,
} from "@delacour/warden-driver/driver.types";
import { E2eError } from "@delacour/warden-driver/e2e-error";
import { driverCalls } from "@delacour/warden-driver/unwrap";
import type { ConditionRecorder } from "./lease-recorder";

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

export type DevicePermissions = {
	/**
	 * Sets permissions of the app, per name (`location`, `camera`, `photos`, `contacts`, `notifications`, `microphone`,
	 * ...): `"granted"`, `"denied"` or `"unset"` (asks again). The result lists the names this platform skipped. Set
	 * them before `app.open()`: iOS terminates a running app when its permission changes.
	 */
	set(grants: PermissionGrants, options?: SettingOptions): Promise<PermissionsState>;
	/** Puts every permission this test set back to the suite's `conditions.permissions`, else `"unset"`. */
	reset(options?: SettingOptions): Promise<void>;
};

export type TimelineStepInput = {
	/** when, from the start of the timeline */
	at: Duration;
	network?: NetworkInput;
	location?: LocationCondition | LatLon;
};

/** What the runner needs of a device's conditions; reached through {@link ConditionRegistry.of}, not on `Device`. */
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
	permissions: DevicePermissions;
	/** Device timezone (`"Asia/Tokyo"`); `null` puts it back. iOS: applies to the app launched next. */
	timezone(tz: string | null): Promise<TimezoneState>;
	/** The app's locale (`"fr-FR"`); `null` puts it back. iOS: applies to the app launched next. Android 13+. */
	locale(tag: string | null, options?: SettingOptions): Promise<LocaleState>;
	/** Text size (a name like `"accessibility-large"` or a scale like `1.5`), bold text, contrast, reduce motion; `null` resets. */
	a11y(op: A11yOp | null): Promise<A11yState>;
	/** Battery level and charging. Android emulators: real. iOS: the status bar only (`cosmetic: true`). `null` resets. */
	battery(op: BatteryOp | null): Promise<BatteryState>;
	/** Android: a critical trim-memory signal to the running app. iOS: `E_UNSUPPORTED` (no delivery mechanism works). */
	memoryWarning(options?: SettingOptions): Promise<void>;
	/** iOS: delivers an APNs payload (`{ aps: { alert: ... } }`) to the app. Android: `E_UNSUPPORTED`. */
	push(payload: PushPayload, options?: SettingOptions): Promise<void>;
	timeline(steps: readonly TimelineStepInput[]): Promise<ConditionRun>;
	internals: ConditionsInternals;
};

/** The slice of the run's env conditions read: the app under test, the suite's starting conditions, the lease to record on. */
export type ConditionsEnv = {
	bundleId: string;
	conditions?: ConditionsConfig;
	leaseId?: string;
};

export type DeviceConditionsDeps = {
	driver: Driver;
	env: ConditionsEnv;
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
const SCENARIOS: readonly LocationScenario[] = ["city-run", "city-bike", "freeway"];

/** Validates and converts what a spec passes to `device.network` / `location` / `clock` into the conditions the driver takes. */
class ConditionInputs {
	/** The a11y op a suite's `conditions.a11y` means (its resolved `fontScale` is not an input). */
	a11yOpOf(config: A11yCondition): A11yOp {
		const { fontScale: _scale, ...op } = config;
		return op;
	}

	invalid(message: string): E2eError {
		return new E2eError("INVALID_ARGUMENT", message);
	}

	durationMs(value: Duration, what: string): number {
		if (typeof value === "number") {
			if (!Number.isFinite(value) || value < 0) throw this.invalid(`${what} must be 0 or more, got ${String(value)}`);
			return value;
		}
		const parsed = durationParser.parse(value);
		if (!parsed.success) throw this.invalid(`${what}: ${parsed.error}`);
		return parsed.data;
	}

	network(input: NetworkInput): NetworkCondition {
		const condition = conditionsConfigs.toNetworkCondition(input);
		if (!condition.success) throw this.invalid(condition.error);
		return condition.data;
	}

	instant(at: ClockInput): Date {
		const date = at instanceof Date ? new Date(at.getTime()) : new Date(at);
		if (Number.isNaN(date.getTime()))
			throw this.invalid(`invalid time ${JSON.stringify(at)} (use an ISO 8601 string, a Date or epoch ms)`);
		return date;
	}

	validatePoint(point: { lat: number; lon: number }): void {
		const ok =
			Number.isFinite(point.lat) &&
			Number.isFinite(point.lon) &&
			Math.abs(point.lat) <= 90 &&
			Math.abs(point.lon) <= 180;
		if (!ok) throw this.invalid(`invalid location ${point.lat},${point.lon} (lat within 90, lon within 180)`);
	}

	locationOf(input: LocationCondition | LatLon): LocationCondition {
		if ("kind" in input) return input;
		this.validatePoint(input);
		return { kind: "point", lat: input.lat, lon: input.lon };
	}
}

const inputs = new ConditionInputs();

/** Ties a device to its conditions' runner hooks, and opens the condition sink of a session. */
export class ConditionRegistry {
	private readonly registry = new WeakMap<object, ConditionsInternals>();

	/** Ties a device (or a wrapper of it) to its conditions' runner hooks; `Device` itself does not expose them. */
	register(device: object, internals: ConditionsInternals): void {
		this.registry.set(device, internals);
	}

	/** The runner hooks of a device made by `DeviceImpl` (or a `DeviceTracer` wrapper of one). */
	of(device: object): ConditionsInternals | undefined {
		return this.registry.get(device);
	}

	/** The condition sink for a session: events append to its `results.jsonl`; none without one. */
	sinkFor(session: { results?: { path: string } }): ConditionSink | undefined {
		return session.results === undefined ? undefined : conditionEvents.openSink(session.results.path);
	}
}

export const conditionRegistry = new ConditionRegistry();

/** `device.network` / `location` / `clock` / `permissions` / ... over one {@link Driver}, with the state to put back. */
export class DeviceConditionsImpl implements DeviceConditions {
	private readonly stderrLog = (line: string): void => {
		process.stderr.write(`${line}\n`);
	};

	private readonly driver: Driver;
	private readonly env: ConditionsEnv;
	private readonly ticker: TickerClock;
	private readonly log: (line: string) => void;
	private readonly baseline: SuiteConditions;
	private readonly recorder: ConditionRecorder | undefined;

	private currentNetwork: NetworkCondition = ONLINE;
	private currentFaults: readonly HostFault[] = [];
	private currentClock: ClockCondition = REAL_CLOCK;
	/** when `currentClock` was set: a fixed clock has run on since */
	private clockSetAt: number;
	private networkDirty = false;
	private locationDirty = false;
	private clockDirty = false;
	private permissionsDirty = false;
	private localeDirty = false;
	private a11yDirty = false;
	private batteryDirty = false;
	/** permission states this test set, per name, and the app they are for */
	private readonly permissionStates = new Map<PermissionName, PermissionState>();
	private permissionBundle: string | undefined;
	private currentLocale: LocaleCondition = {};
	private currentA11y: A11yCondition = {};
	private flap: { run: ConditionRun; options: FlapOptions } | undefined;
	private readonly runs = new Set<ConditionRun>();

	readonly internals: ConditionsInternals;

	constructor(private readonly deps: DeviceConditionsDeps) {
		this.driver = deps.driver;
		this.env = deps.env;
		this.ticker = deps.tickerClock ?? realTickerClock;
		this.log = deps.log ?? this.stderrLog;
		this.recorder = deps.recorder;
		const normalized = conditionsConfigs.normalizeConditions(this.env.conditions ?? {});
		if (!normalized.success) throw new E2eError("SESSION", `invalid conditions: ${normalized.error}`);
		this.baseline = normalized.data.conditions;
		this.clockSetAt = this.ticker.now();
		this.internals = this.buildInternals();
	}

	readonly network: DeviceNetwork = {
		set: (input, options) => this.setNetwork(input, options),
		during: async (condition, fn, options) => {
			const previous = this.currentNetwork;
			const previousFlap = this.flap?.options;
			await this.setNetwork(condition, options);
			let result: Awaited<ReturnType<typeof fn>>;
			try {
				result = await fn();
			} catch (error) {
				await this.restoreNetwork(previous, previousFlap, options).catch((restoreError: unknown) =>
					this.log(
						`[warden-e2e] network.during: restoring the previous network failed: ${String(restoreError instanceof Error ? restoreError.message : restoreError)}`
					)
				);
				throw error;
			}
			await this.restoreNetwork(previous, previousFlap, options);
			return result;
		},
		flap: (options) => this.startFlapRun(options),
		fault: (rules) => this.setFaults("match" in rules ? [rules] : rules),
		status: async () => ({
			condition: this.currentNetwork,
			faults: this.currentFaults,
			flapping: this.flap !== undefined,
		}),
		reset: () => this.resetNetwork(),
	};

	readonly location: DeviceLocation = {
		set: async (point) => {
			inputs.validatePoint(point);
			await this.applyLocation({
				kind: "point",
				lat: point.lat,
				lon: point.lon,
				...(point.altM === undefined ? {} : { altM: point.altM }),
			});
		},
		route: async (points, options = {}) => {
			const pace = {
				...(options.speedMps === undefined ? {} : { speedMps: options.speedMps }),
			};
			if ("gpx" in points) {
				await this.applyLocation({ kind: "gpx", path: resolve(points.gpx), ...pace });
				return;
			}
			if (points.length === 0) throw inputs.invalid("a route needs at least one point");
			for (const point of points) inputs.validatePoint(point);
			await this.applyLocation({
				kind: "route",
				points,
				...pace,
				...(options.intervalS === undefined ? {} : { intervalS: options.intervalS }),
				...(options.loop === undefined ? {} : { loop: options.loop }),
			});
		},
		scenario: async (name) => {
			if (!SCENARIOS.includes(name)) {
				throw inputs.invalid(`unknown scenario "${String(name)}" (use ${SCENARIOS.join(", ")})`);
			}
			await this.applyLocation({ kind: "scenario", name });
		},
		clear: () => this.applyLocation({ kind: "clear" }),
	};

	readonly clock: DeviceClock = {
		set: async (at, options) => {
			await this.applyClock(this.clockFor(at, options?.frozen));
		},
		advance: async (by) => {
			await this.applyClock(this.advanced(inputs.durationMs(by, "advance")));
		},
		during: async (at, fn, options) => {
			const previous = this.currentClock;
			await this.applyClock(this.clockFor(at, options?.frozen));
			let result: Awaited<ReturnType<typeof fn>>;
			try {
				result = await fn();
			} catch (error) {
				await this.applyClock(previous).catch((restoreError: unknown) =>
					this.log(
						`[warden-e2e] clock.during: restoring the previous clock failed: ${String(restoreError instanceof Error ? restoreError.message : restoreError)}`
					)
				);
				throw error;
			}
			await this.applyClock(previous);
			return result;
		},
		reset: async () => {
			await this.applyClock(this.baseline.clock ?? REAL_CLOCK);
			this.clockDirty = false;
		},
		status: () => this.currentClock,
	};

	readonly permissions: DevicePermissions = {
		set: (grants, options) => this.applyPermissions(grants, options),
		reset: async (options) => {
			const baselinePermissions = this.baseline.permissions ?? {};
			const back: PermissionGrants = {};
			for (const name of this.permissionStates.keys()) back[name] = baselinePermissions[name] ?? "unset";
			if (Object.keys(back).length === 0) return;
			await this.applyPermissions(
				back,
				options ?? (this.permissionBundle ? { bundleId: this.permissionBundle } : undefined)
			);
			this.permissionsDirty = false;
			this.permissionStates.clear();
			this.recorder?.settle("permission", { grants: [] }, true);
		},
	};

	readonly timezone: DeviceConditions["timezone"] = (tz) => this.applyTimezone(tz);
	readonly locale: DeviceConditions["locale"] = (tag, options) => this.applyLocale(tag, options);
	readonly a11y: DeviceConditions["a11y"] = (op) => this.applyA11y(op);
	readonly battery: DeviceConditions["battery"] = (op) => this.applyBattery(op);
	readonly timeline: DeviceConditions["timeline"] = (steps) => this.startTimelineRun(steps);

	readonly memoryWarning: DeviceConditions["memoryWarning"] = async (options) => {
		const op = this.settingOp("memoryWarning");
		await this.call("memoryWarning", () => op(options ?? { bundleId: this.env.bundleId }));
	};

	readonly push: DeviceConditions["push"] = async (payload, options) => {
		const op = this.settingOp("push");
		await this.call("push", () => op(payload, options ?? { bundleId: this.env.bundleId }));
	};

	private emit(event: ConditionChange): void {
		this.deps.sink?.({ ...event, type: "condition", at: this.ticker.now() });
	}

	/** One driver call: raced against the attempt's signal, a failure thrown as an `E2eError`. */
	private async call<T>(what: string, run: () => DriverResult<T>): Promise<T> {
		const result = await driverCalls.settled(run, what, this.deps.signal());
		if (result.success) return result.data;
		const error = driverCalls.toE2eError(result.error, what);
		if (result.error.code === "E_NETWORK_RELAUNCH") {
			throw new E2eError(
				error.code,
				`${error.message}\nthe app runs without the warden network dylib: declare \`conditions.network\` for the suite so it launches with it, or pass { relaunch: true }`
			);
		}
		throw error;
	}

	/** a flap or timeline step that landed is on the lease too: a crash mid-flap can be undone */
	private target(options?: NetworkSetOptions): SchedulerTarget {
		const { driver, recorder } = this;
		return {
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
		};
	}

	private track(scheduler: Scheduler): ConditionRun {
		const run: ConditionRun = {
			stop: async () => {
				scheduler.stop();
				const outcome = await scheduler.done;
				this.runs.delete(run);
				if (this.flap?.run === run) this.flap = undefined;
				return outcome;
			},
			done: scheduler.done,
			status: () => scheduler.current(),
		};
		this.runs.add(run);
		return run;
	}

	private async stopFlap(): Promise<void> {
		const running = this.flap;
		if (running === undefined) return;
		await running.run.stop();
	}

	private async applyNetwork(condition: NetworkCondition, options?: NetworkSetOptions): Promise<NetworkState> {
		await this.stopFlap();
		this.networkDirty = true;
		const opts = options?.relaunch === undefined ? undefined : { relaunch: options.relaunch };
		const state = await this.call("network", () => this.driver.network(condition, opts));
		this.currentNetwork = condition;
		this.recorder?.record("network", condition);
		this.emit({ area: "network", value: condition });
		return state;
	}

	private async startFlapRun(options: FlapOptions, netOptions?: NetworkSetOptions): Promise<ConditionRun> {
		const upMs = inputs.durationMs(options.up, "flap up");
		const downMs = inputs.durationMs(options.down, "flap down");
		if (!(upMs > 0 && downMs > 0)) throw inputs.invalid("flap needs up and down above 0");
		const base = options.base === undefined ? ONLINE : inputs.network(options.base);
		if (base.kind === "flap") throw inputs.invalid("flap base cannot itself be a flap");
		await this.applyNetwork(base, netOptions);
		const scheduler = schedulers.startFlap(
			this.target(netOptions),
			{
				upMs,
				downMs,
				base,
				applyInitial: false,
				...(options.jitterPct === undefined ? {} : { jitterPct: options.jitterPct }),
				...(options.seed === undefined ? {} : { seed: options.seed }),
			},
			{ ...this.ticker, ...(this.deps.sink === undefined ? {} : { sink: this.deps.sink }) }
		);
		const run = this.track(scheduler);
		this.flap = { run, options };
		this.currentNetwork = {
			kind: "flap",
			upMs,
			downMs,
			base,
			...(options.jitterPct === undefined ? {} : { jitterPct: options.jitterPct }),
		};
		this.emit({ area: "network", value: this.currentNetwork });
		return run;
	}

	private async setNetwork(input: NetworkInput, options?: NetworkSetOptions): Promise<NetworkState> {
		const condition = inputs.network(input);
		if (condition.kind === "flap") {
			await this.startFlapRun(
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
		return this.applyNetwork(condition, options);
	}

	private async restoreNetwork(
		previous: NetworkCondition,
		previousFlap: FlapOptions | undefined,
		options?: NetworkSetOptions
	): Promise<void> {
		if (previous.kind === "flap" && previousFlap !== undefined) await this.startFlapRun(previousFlap, options);
		else await this.applyNetwork(previous, options);
	}

	private async resetNetwork(): Promise<void> {
		await this.stopFlap();
		if (this.currentFaults.length > 0) await this.setFaults([]);
		const goal = this.baseline.network ?? ONLINE;
		await this.applyNetwork(goal);
		this.networkDirty = false;
		this.recorder?.settle("network", goal, goal.kind === "online");
	}

	private async setFaults(rules: readonly HostFault[]): Promise<{ notes: readonly string[] }> {
		this.networkDirty = true;
		const result = await this.call("network faults", () => this.driver.networkFaults(rules));
		this.currentFaults = rules;
		this.recorder?.record("network", this.currentNetwork);
		this.emit({ area: "faults", value: { kind: "faults", rules } });
		return result;
	}

	private async applyLocation(op: LocationCondition): Promise<void> {
		this.locationDirty = true;
		await this.call("location", () => this.driver.location(op));
		this.recorder?.record("location", op);
		this.emit({ area: "location", value: op });
	}

	private async applyClock(condition: ClockCondition): Promise<void> {
		const { driver } = this;
		// a remote driver offers only the ops its server has, so `clock` can be missing at runtime
		const op: Driver["clock"] | undefined = driver.clock;
		this.clockDirty = true;
		if (typeof op !== "function") {
			throw driverCalls.toE2eError(
				{ code: "E_UNSUPPORTED", message: "this driver has no clock condition", retryable: false },
				"clock"
			);
		}
		await this.call("clock", () => op.call(driver, condition));
		this.currentClock = condition;
		this.clockSetAt = this.ticker.now();
		this.emit({ area: "clock", value: condition });
	}

	private clockFor(at: ClockInput, frozen: boolean | undefined): ClockCondition {
		const iso = inputs.instant(at).toISOString();
		return frozen === true ? { kind: "frozen", at: iso } : { kind: "fixed", at: iso };
	}

	private advanced(by: number): ClockCondition {
		const current = this.currentClock;
		switch (current.kind) {
			case "real":
				return { kind: "offset", ms: by };
			case "offset":
				return { kind: "offset", ms: current.ms + by };
			case "frozen":
				return { kind: "frozen", at: new Date(Date.parse(current.at) + by).toISOString() };
			case "fixed": {
				const now = Date.parse(current.at) + (this.ticker.now() - this.clockSetAt);
				return { kind: "fixed", at: new Date(now + by).toISOString() };
			}
		}
	}

	/** a remote driver offers only the ops its server has, so a setting op can be missing at runtime */
	private settingOp<K extends "permissions" | "timezone" | "locale" | "a11y" | "battery" | "memoryWarning" | "push">(
		name: K
	): Driver[K] {
		const op: Driver[K] | undefined = this.driver[name];
		if (typeof op !== "function") {
			throw driverCalls.toE2eError(
				{ code: "E_UNSUPPORTED", message: `this driver has no ${name} op`, retryable: false },
				name
			);
		}
		return op.bind(this.driver) as Driver[K];
	}

	private recordPermissions(bundleId: string): void {
		const value: PermissionCondition = {
			grants: [...this.permissionStates].map(([permission, state]) => ({ bundleId, permission, state })),
		};
		this.recorder?.record("permission", value);
		this.emit({ area: "permission", value });
	}

	private async applyPermissions(grants: PermissionGrants, options?: SettingOptions): Promise<PermissionsState> {
		this.permissionsDirty = true;
		const op = this.settingOp("permissions");
		const state = await this.call("permissions", () => op(grants, options ?? { bundleId: this.env.bundleId }));
		for (const { permission, state: applied } of state.applied) this.permissionStates.set(permission, applied);
		this.permissionBundle = state.bundleId;
		this.recordPermissions(state.bundleId);
		return state;
	}

	private recordLocale(): void {
		const current = this.currentLocale;
		const empty = current.locale === undefined && current.timezone === undefined;
		if (empty) this.recorder?.settle("locale", current, true);
		else this.recorder?.record("locale", current);
		this.emit({ area: "locale", value: current });
	}

	private async applyTimezone(tz: string | null): Promise<TimezoneState> {
		this.localeDirty = true;
		const op = this.settingOp("timezone");
		const previous = this.currentLocale.previousTimezone;
		const state = await this.call("timezone", () => op(tz, previous === undefined ? undefined : { previous }));
		const { timezone: _gone, ...rest } = this.currentLocale;
		this.currentLocale = {
			...rest,
			...(tz === null ? {} : { timezone: tz }),
			...((previous ?? state.previous) ? { previousTimezone: previous ?? state.previous } : {}),
		};
		this.recordLocale();
		return state;
	}

	private async applyLocale(tag: string | null, options?: SettingOptions): Promise<LocaleState> {
		this.localeDirty = true;
		const op = this.settingOp("locale");
		const state = await this.call("locale", () => op(tag, options ?? { bundleId: this.env.bundleId }));
		const { locale: _gone, ...rest } = this.currentLocale;
		this.currentLocale = {
			...rest,
			...(tag === null ? {} : { locale: tag }),
			...(state.bundleId === undefined ? {} : { bundleId: state.bundleId }),
		};
		this.recordLocale();
		return state;
	}

	private checkedA11y(op: A11yOp | null): void {
		if (op === null) return;
		if (op.textSize !== undefined) {
			const size = textSizes.resolveTextSize(op.textSize);
			if (!size.success) throw inputs.invalid(size.error);
		}
		if (Object.keys(op).length === 0)
			throw inputs.invalid("a11y needs at least one of textSize, boldText, contrast, reduceMotion");
	}

	private async applyA11y(op: A11yOp | null): Promise<A11yState> {
		this.checkedA11y(op);
		this.a11yDirty = true;
		const run = this.settingOp("a11y");
		const state = await this.call("a11y", () => run(op));
		const resolved = op?.textSize === undefined ? undefined : textSizes.resolveTextSize(op.textSize);
		this.currentA11y =
			op === null
				? {}
				: {
						...this.currentA11y,
						...textSizes.appliedA11y(op, state.applied),
						...(resolved?.success ? { fontScale: resolved.data.scale } : {}),
					};
		if (Object.keys(this.currentA11y).length === 0) this.recorder?.settle("a11y", this.currentA11y, true);
		else this.recorder?.record("a11y", this.currentA11y);
		this.emit({ area: "a11y", value: this.currentA11y });
		return state;
	}

	private async applyBattery(op: BatteryOp | null): Promise<BatteryState> {
		this.batteryDirty = true;
		const run = this.settingOp("battery");
		const state = await this.call("battery", () => run(op));
		const value: BatteryCondition = op === null ? {} : { ...op, cosmetic: state.cosmetic };
		if (op === null) this.recorder?.settle("battery", value, true);
		else this.recorder?.record("battery", value);
		this.emit({ area: "battery", value });
		return state;
	}

	private async startTimelineRun(steps: readonly TimelineStepInput[]): Promise<ConditionRun> {
		const converted: TimelineStep[] = steps.map((step, index) => {
			const atMs = inputs.durationMs(step.at, `timeline step ${index} at`);
			const converted: TimelineStep = { atMs };
			if (step.network !== undefined) {
				const condition = inputs.network(step.network);
				if (condition.kind === "flap")
					throw inputs.invalid(`timeline step ${index}: use device.network.flap for a flap`);
				converted.network = condition;
			}
			if (step.location !== undefined) converted.location = inputs.locationOf(step.location);
			return converted;
		});
		this.networkDirty = true;
		this.locationDirty = true;
		const scheduler = schedulers.startTimeline(this.target(), converted, {
			...this.ticker,
			...(this.deps.sink === undefined ? {} : { sink: this.deps.sink }),
		});
		const status = scheduler.current();
		if (status.state === "failed") throw inputs.invalid(status.error);
		const run = this.track(scheduler);
		const last = converted.at(-1);
		if (last?.network !== undefined) this.currentNetwork = last.network;
		return run;
	}

	private async stopRuns(): Promise<void> {
		const failures: string[] = [];
		for (const run of [...this.runs]) {
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

	private buildInternals(): ConditionsInternals {
		const { baseline } = this;
		const declared =
			baseline.network !== undefined ||
			baseline.location !== undefined ||
			baseline.clock !== undefined ||
			baseline.permissions !== undefined ||
			baseline.locale !== undefined ||
			baseline.timezone !== undefined ||
			baseline.a11y !== undefined;
		return {
			declared,
			dirty: () =>
				this.networkDirty ||
				this.locationDirty ||
				this.clockDirty ||
				this.permissionsDirty ||
				this.localeDirty ||
				this.a11yDirty ||
				this.batteryDirty ||
				this.runs.size > 0,
			wantsInject: () =>
				baseline.network !== undefined ||
				baseline.clock !== undefined ||
				this.currentNetwork.kind !== "online" ||
				this.currentClock.kind !== "real",
			applyBaseline: () => this.applyBaseline(),
			teardown: () => this.teardown(),
		};
	}

	private async applyBaseline(): Promise<void> {
		const { baseline } = this;
		if (baseline.permissions !== undefined) {
			for (const [name, state] of Object.entries(baseline.permissions))
				this.permissionStates.set(name as PermissionName, state);
			await this.applyPermissions(baseline.permissions);
		}
		const steps: ReadonlyArray<readonly [unknown, () => Promise<unknown>]> = [
			[baseline.timezone, () => this.applyTimezone(baseline.timezone ?? null)],
			[baseline.locale, () => this.applyLocale(baseline.locale ?? null)],
			[baseline.a11y, () => this.applyA11y(inputs.a11yOpOf(baseline.a11y as NonNullable<typeof baseline.a11y>))],
			[baseline.clock, () => this.applyClock(baseline.clock as NonNullable<typeof baseline.clock>)],
			[baseline.location, () => this.applyLocation(baseline.location as NonNullable<typeof baseline.location>)],
			[
				baseline.network,
				() => this.applyNetwork(baseline.network as NonNullable<typeof baseline.network>, { relaunch: true }),
			],
		];
		for (const [wanted, apply] of steps) if (wanted !== undefined) await apply();
		this.networkDirty = false;
		this.locationDirty = false;
		this.clockDirty = false;
		this.permissionsDirty = false;
		this.localeDirty = false;
		this.a11yDirty = false;
		this.batteryDirty = false;
	}

	private async teardown(): Promise<void> {
		const { baseline, recorder } = this;
		const errors: unknown[] = [];
		const attempt = async (run: () => Promise<void>): Promise<void> => {
			try {
				await run();
			} catch (error) {
				errors.push(error);
			}
		};
		await attempt(() => this.stopRuns());
		const steps: ReadonlyArray<readonly [boolean, () => Promise<void>]> = [
			[this.networkDirty, () => this.resetNetwork()],
			[
				this.locationDirty,
				async () => {
					const goal = baseline.location ?? { kind: "clear" };
					await this.applyLocation(goal);
					this.locationDirty = false;
					recorder?.settle("location", goal, goal.kind === "clear");
				},
			],
			[this.clockDirty, this.clock.reset],
			[this.permissionsDirty, () => this.permissions.reset()],
			[
				this.localeDirty,
				async () => {
					await this.applyTimezone(baseline.timezone ?? null);
					await this.applyLocale(baseline.locale ?? null);
					this.localeDirty = false;
				},
			],
			[
				this.a11yDirty,
				async () => {
					await this.applyA11y(null);
					if (baseline.a11y !== undefined) await this.applyA11y(inputs.a11yOpOf(baseline.a11y));
					this.a11yDirty = false;
				},
			],
			[
				this.batteryDirty,
				async () => {
					await this.applyBattery(null);
					this.batteryDirty = false;
				},
			],
		];
		for (const [dirty, run] of steps) if (dirty) await attempt(run);
		if (errors.length > 0) throw errors[0];
	}
}
