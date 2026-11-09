import { dirname, resolve } from "node:path";
import { stageCameraFeed } from "@delacour/warden-core/conditions/camera-media";
import {
	type NetworkInput,
	normalizeConditions,
	type SuiteConditions,
	toNetworkCondition,
} from "@delacour/warden-core/conditions/conditions.config";
import {
	type A11yCondition,
	type BatteryCondition,
	type CameraCondition,
	type CameraFacing,
	type ClockCondition,
	DEFAULT_KEYBOARD_MODE,
	type HostFault,
	KEYBOARD_MODES,
	type KeyboardCondition,
	type KeyboardMode,
	type LatLon,
	type LocaleCondition,
	type LocationCondition,
	type LocationScenario,
	type NetworkCondition,
	type PermissionCondition,
	type PermissionName,
	type PermissionState,
} from "@delacour/warden-core/conditions/conditions.types";
import { appliedA11y, resolveTextSize } from "@delacour/warden-core/conditions/text-size";
import { parseDuration } from "@delacour/warden-core/duration";
import { wardenHome } from "@delacour/warden-core/store";
import type {
	A11yOp,
	A11yState,
	BatteryOp,
	BatteryState,
	CameraState,
	Driver,
	DriverResult,
	KeyboardResult,
	LocaleState,
	NetworkState,
	PermissionGrants,
	PermissionsState,
	PushPayload,
	SettingOptions,
	TimezoneState,
} from "../driver/driver.types";
import { settled, toE2eError } from "../driver/unwrap";
import type { E2eEnv } from "../env";
import { E2eError } from "../errors";
import { callerFile } from "../runner/callsite";
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

/** `facing` of `device.camera.set` / `clear`: one camera, or `"both"`. */
export type CameraFacingChoice = CameraFacing | "both";

export type CameraSetOptions = {
	/** which camera plays the asset; default `"back"` */
	facing?: CameraFacingChoice;
	/** video only: play again from the start at the end; default true */
	loop?: boolean;
};

export type DeviceCamera = {
	/**
	 * Feeds the png, jpg, heic, mp4 or mov at `path` (relative to the spec file) into the app's camera, replacing what
	 * that facing played; the other facing keeps its feed. The result says when it shows: `appliesOnLaunch` (iOS: an
	 * app launched without the camera sees it from the next launch), `appliesOnCameraOpen` (Android: the app's next
	 * camera open) or `rebooted` (Android: a video feed restarted the emulator). Android needs a `--camera` device
	 * (`E_CAMERA_DEVICE` otherwise); a missing or unsupported file fails with `E_CAMERA_NOT_FOUND` / `E_CAMERA_MEDIA`.
	 * Taken off when the test ends (back to the suite's `camera`).
	 */
	set(path: string, options?: CameraSetOptions): Promise<CameraState>;
	/** Takes the feed off one camera, or both (the default). */
	clear(facing?: CameraFacingChoice): Promise<CameraState>;
	/** The feeds this spec has in place. */
	status(): Promise<CameraState>;
};

export type DeviceConditions = {
	camera: DeviceCamera;
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
	/**
	 * The on-screen keyboard: `software` (the default) keeps it up while the spec types, `hardware` hides it (input as from
	 * a connected keyboard), `toggle` flips the mode this spec has in place. Live, no relaunch. Put back to the suite's
	 * `conditions.keyboard` (else `software`) when the test ends.
	 */
	keyboard(mode: KeyboardMode | "toggle"): Promise<KeyboardResult>;
	/** Android: a critical trim-memory signal to the running app. iOS: `E_UNSUPPORTED` (no delivery mechanism works). */
	memoryWarning(options?: SettingOptions): Promise<void>;
	/** iOS: delivers an APNs payload (`{ aps: { alert: ... } }`) to the app. Android: `E_UNSUPPORTED`. */
	push(payload: PushPayload, options?: SettingOptions): Promise<void>;
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
	/** the warden home camera assets are staged under; default `$WARDEN_HOME` / `~/.warden` */
	wardenHome?: string;
	/** the directory a relative camera path is resolved against; default the calling spec file's, else `specsDir`, else cwd */
	specDir?: () => string | undefined;
};

type ConditionChange = ConditionEvent extends infer E
	? E extends ConditionEvent
		? Omit<E, "type" | "at">
		: never
	: never;

const ONLINE: NetworkCondition = { kind: "online" };
const REAL_CLOCK: ClockCondition = { kind: "real" };

/** The a11y op a suite's `conditions.a11y` means (its resolved `fontScale` is not an input). */
function a11yOpOf(config: A11yCondition): A11yOp {
	const { fontScale: _scale, ...op } = config;
	return op;
}

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

/** This package's own sources: frames in them (tracing wrappers, this module) are never "the spec" (its tests are). */
const PACKAGE_SRC = `${resolve(import.meta.dir, "..")}/`;

/** The directory of the spec file that called into the device API, from the stack of the call; undefined when unknown. */
function callingSpecDir(): string | undefined {
	const file = callerFile(new Error().stack, (path) => path.startsWith(PACKAGE_SRC) && !path.endsWith(".test.ts"));
	return file === "unknown" ? undefined : dirname(file);
}

const FACINGS: Record<CameraFacingChoice, readonly CameraFacing[]> = {
	back: ["back"],
	front: ["front"],
	both: ["back", "front"],
};

function facingsOf(choice: CameraFacingChoice | undefined): readonly CameraFacing[] {
	const facings = FACINGS[choice ?? "back"];
	if (facings === undefined) throw invalid(`unknown camera facing "${String(choice)}" (use back, front or both)`);
	return facings;
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
	let permissionsDirty = false;
	let localeDirty = false;
	let a11yDirty = false;
	let batteryDirty = false;
	let keyboardDirty = false;
	let currentKeyboard: KeyboardMode = DEFAULT_KEYBOARD_MODE;
	let cameraDirty = false;
	let currentCamera: CameraCondition = {};
	/** permission states this test set, per name, and the app they are for */
	const permissionStates = new Map<PermissionName, PermissionState>();
	let permissionBundle: string | undefined;
	let currentLocale: LocaleCondition = {};
	let currentA11y: A11yCondition = {};
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

	/** a remote driver offers only the ops its server has, so a setting op can be missing at runtime */
	function settingOp<
		K extends
			| "permissions"
			| "timezone"
			| "locale"
			| "a11y"
			| "battery"
			| "keyboard"
			| "camera"
			| "memoryWarning"
			| "push",
	>(name: K): Driver[K] {
		const op: Driver[K] | undefined = driver[name];
		if (typeof op !== "function") {
			throw toE2eError({ code: "E_UNSUPPORTED", message: `this driver has no ${name} op`, retryable: false }, name);
		}
		return op.bind(driver) as Driver[K];
	}

	const recordPermissions = (bundleId: string): void => {
		const value: PermissionCondition = {
			grants: [...permissionStates].map(([permission, state]) => ({ bundleId, permission, state })),
		};
		recorder?.record("permission", value);
		emit({ area: "permission", value });
	};

	async function applyPermissions(grants: PermissionGrants, options?: SettingOptions): Promise<PermissionsState> {
		permissionsDirty = true;
		const op = settingOp("permissions");
		const state = await call("permissions", () => op(grants, options ?? { bundleId: env.bundleId }));
		for (const { permission, state: applied } of state.applied) permissionStates.set(permission, applied);
		permissionBundle = state.bundleId;
		recordPermissions(state.bundleId);
		return state;
	}

	const permissionsApi: DevicePermissions = {
		set: applyPermissions,
		async reset(options) {
			const baselinePermissions = baseline.permissions ?? {};
			const back: PermissionGrants = {};
			for (const name of permissionStates.keys()) back[name] = baselinePermissions[name] ?? "unset";
			if (Object.keys(back).length === 0) return;
			await applyPermissions(back, options ?? (permissionBundle ? { bundleId: permissionBundle } : undefined));
			permissionsDirty = false;
			permissionStates.clear();
			recorder?.settle("permission", { grants: [] }, true);
		},
	};

	function recordLocale(): void {
		const empty = currentLocale.locale === undefined && currentLocale.timezone === undefined;
		if (empty) recorder?.settle("locale", currentLocale, true);
		else recorder?.record("locale", currentLocale);
		emit({ area: "locale", value: currentLocale });
	}

	async function applyTimezone(tz: string | null): Promise<TimezoneState> {
		localeDirty = true;
		const op = settingOp("timezone");
		const previous = currentLocale.previousTimezone;
		const state = await call("timezone", () => op(tz, previous === undefined ? undefined : { previous }));
		const { timezone: _gone, ...rest } = currentLocale;
		currentLocale = {
			...rest,
			...(tz === null ? {} : { timezone: tz }),
			...((previous ?? state.previous) ? { previousTimezone: previous ?? state.previous } : {}),
		};
		recordLocale();
		return state;
	}

	async function applyLocale(tag: string | null, options?: SettingOptions): Promise<LocaleState> {
		localeDirty = true;
		const op = settingOp("locale");
		const state = await call("locale", () => op(tag, options ?? { bundleId: env.bundleId }));
		const { locale: _gone, ...rest } = currentLocale;
		currentLocale = {
			...rest,
			...(tag === null ? {} : { locale: tag }),
			...(state.bundleId === undefined ? {} : { bundleId: state.bundleId }),
		};
		recordLocale();
		return state;
	}

	function checkedA11y(op: A11yOp | null): void {
		if (op === null) return;
		if (op.textSize !== undefined) {
			const size = resolveTextSize(op.textSize);
			if (!size.success) throw invalid(size.error);
		}
		if (Object.keys(op).length === 0)
			throw invalid("a11y needs at least one of textSize, boldText, contrast, reduceMotion");
	}

	async function applyA11y(op: A11yOp | null): Promise<A11yState> {
		checkedA11y(op);
		a11yDirty = true;
		const run = settingOp("a11y");
		const state = await call("a11y", () => run(op));
		const resolved = op?.textSize === undefined ? undefined : resolveTextSize(op.textSize);
		currentA11y =
			op === null
				? {}
				: {
						...currentA11y,
						...appliedA11y(op, state.applied),
						...(resolved?.success ? { fontScale: resolved.data.scale } : {}),
					};
		if (op?.screenReader === false && currentA11y.screenReaderPrevious !== undefined) {
			// Android TalkBack is back off and the device restored: nothing of it stays on the record
			const { screenReader: _off, screenReaderPrevious: _prior, ...rest } = currentA11y;
			currentA11y = rest;
		} else if (state.screenReaderPrevious !== undefined) {
			currentA11y = { ...currentA11y, screenReaderPrevious: state.screenReaderPrevious };
		}
		if (Object.keys(currentA11y).length === 0) recorder?.settle("a11y", currentA11y, true);
		else recorder?.record("a11y", currentA11y);
		emit({ area: "a11y", value: currentA11y });
		return state;
	}

	async function applyBattery(op: BatteryOp | null): Promise<BatteryState> {
		batteryDirty = true;
		const run = settingOp("battery");
		const state = await call("battery", () => run(op));
		const value: BatteryCondition = op === null ? {} : { ...op, cosmetic: state.cosmetic };
		if (op === null) recorder?.settle("battery", value, true);
		else recorder?.record("battery", value);
		emit({ area: "battery", value });
		return state;
	}

	/** warden's device: a lease records what we change, and a phone is never ours to change */
	const ownsDevice = recorder !== undefined && env.deviceKind !== "physical";
	const keyboardGoal: KeyboardMode = baseline.keyboard?.mode ?? DEFAULT_KEYBOARD_MODE;

	async function applyKeyboard(input: KeyboardMode | "toggle"): Promise<KeyboardResult> {
		const mode = input === "toggle" ? (currentKeyboard === "software" ? "hardware" : "software") : input;
		if (!KEYBOARD_MODES.includes(mode)) {
			throw invalid(`unknown keyboard mode "${String(input)}" (use software, hardware or toggle)`);
		}
		keyboardDirty = true;
		const run = settingOp("keyboard");
		const state = await call("keyboard", () => run(mode));
		currentKeyboard = mode;
		const value: KeyboardCondition = {
			mode,
			...(state.previousIme === undefined ? {} : { previousIme: state.previousIme }),
		};
		if (mode === DEFAULT_KEYBOARD_MODE) recorder?.settle("keyboard", value, true);
		else recorder?.record("keyboard", value);
		emit({ area: "keyboard", value });
		return state;
	}

	const home = deps.wardenHome ?? wardenHome(process.env);

	/** The whole next camera state to the driver; the feeds that landed are recorded on the lease and reported. */
	async function applyCamera(next: CameraCondition): Promise<CameraState> {
		cameraDirty = true;
		const run = settingOp("camera");
		const empty = Object.keys(next).length === 0;
		const state = await call("camera", () => run(empty ? null : next));
		currentCamera = state.feeds;
		if (Object.keys(currentCamera).length === 0) recorder?.settle("camera", currentCamera, true);
		else recorder?.record("camera", currentCamera);
		emit({ area: "camera", value: currentCamera });
		return state;
	}

	/** A feed copied under the device's camera dir; a missing or unsupported file is an `INVALID_ARGUMENT` naming the code. */
	function stage(facing: CameraFacing, source: string, loop: boolean): CameraCondition[CameraFacing] {
		const staged = stageCameraFeed({ wardenHome: home, udid: env.udid, facing, source, loop });
		if (!staged.success) {
			throw invalid(`camera failed: ${staged.error.code}: ${staged.error.message}`);
		}
		return staged.data;
	}

	function specPath(path: string, dir: string | undefined): string {
		if (typeof path !== "string" || path === "") throw invalid("camera.set needs the path of an image or video");
		return resolve(dir ?? (env.specsDir !== undefined ? resolve(env.specsDir) : process.cwd()), path);
	}

	const cameraApi: DeviceCamera = {
		async set(path, options = {}) {
			const dir = (deps.specDir ?? callingSpecDir)();
			const source = specPath(path, dir);
			const facings = facingsOf(options.facing);
			const loop = options.loop ?? true;
			const next: CameraCondition = { ...currentCamera };
			for (const facing of facings) {
				const feed = stage(facing, source, loop);
				if (feed !== undefined) next[facing] = feed;
			}
			return applyCamera(next);
		},
		async clear(facing = "both") {
			const next: CameraCondition = { ...currentCamera };
			for (const f of facingsOf(facing)) delete next[f];
			return applyCamera(next);
		},
		async status() {
			return { feeds: currentCamera };
		},
	};

	/** The suite's `camera` as staged feeds. */
	function baselineCamera(): CameraCondition {
		const feeds: CameraCondition = {};
		for (const facing of ["back", "front"] as const) {
			const configured = env.cameraFeeds?.[facing];
			if (configured === undefined) continue;
			const feed = stage(facing, configured.path, configured.loop);
			if (feed !== undefined) feeds[facing] = feed;
		}
		return feeds;
	}

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

	const declared =
		baseline.network !== undefined ||
		baseline.location !== undefined ||
		baseline.clock !== undefined ||
		baseline.permissions !== undefined ||
		baseline.locale !== undefined ||
		baseline.timezone !== undefined ||
		baseline.a11y !== undefined ||
		baseline.keyboard !== undefined ||
		ownsDevice ||
		env.cameraFeeds !== undefined;

	/** Puts the baseline's permissions in place, remembering each state so a later reset knows what to restore. */
	async function applyBaselinePermissions(): Promise<void> {
		if (baseline.permissions === undefined) return;
		for (const [name, state] of Object.entries(baseline.permissions))
			permissionStates.set(name as PermissionName, state);
		await applyPermissions(baseline.permissions);
	}

	/** What `applyBaseline` puts in place, in order; each step does nothing when the baseline leaves its area undeclared. */
	const baselineSteps: readonly (() => Promise<void>)[] = [
		applyBaselinePermissions,
		async () => {
			if (baseline.timezone !== undefined) await applyTimezone(baseline.timezone);
		},
		async () => {
			if (baseline.locale !== undefined) await applyLocale(baseline.locale);
		},
		async () => {
			if (baseline.a11y !== undefined) await applyA11y(a11yOpOf(baseline.a11y));
		},
		async () => {
			if (baseline.clock !== undefined) await applyClock(baseline.clock);
		},
		async () => {
			if (baseline.location !== undefined) await applyLocation(baseline.location);
		},
		async () => {
			if (baseline.network !== undefined) await applyNetwork(baseline.network, { relaunch: true });
		},
		async () => {
			if (env.cameraFeeds !== undefined) await applyCamera(baselineCamera());
		},
		async () => {
			if (baseline.keyboard !== undefined || ownsDevice) await applyKeyboard(keyboardGoal);
		},
	];

	/** What `teardown` undoes after `stopRuns`, in order: each runs only while its area is dirty. */
	const teardownSteps: readonly { dirty: () => boolean; run: () => Promise<void> }[] = [
		{ dirty: () => networkDirty, run: resetNetwork },
		{
			dirty: () => locationDirty,
			run: async () => {
				const goal = baseline.location ?? { kind: "clear" };
				await applyLocation(goal);
				locationDirty = false;
				recorder?.settle("location", goal, goal.kind === "clear");
			},
		},
		{ dirty: () => clockDirty, run: clockApi.reset },
		{ dirty: () => permissionsDirty, run: () => permissionsApi.reset() },
		{
			dirty: () => localeDirty,
			run: async () => {
				await applyTimezone(baseline.timezone ?? null);
				await applyLocale(baseline.locale ?? null);
				localeDirty = false;
			},
		},
		{
			dirty: () => a11yDirty,
			run: async () => {
				await applyA11y(null);
				if (baseline.a11y !== undefined) await applyA11y(a11yOpOf(baseline.a11y));
				a11yDirty = false;
			},
		},
		{
			dirty: () => batteryDirty,
			run: async () => {
				await applyBattery(null);
				batteryDirty = false;
			},
		},
		{
			dirty: () => keyboardDirty,
			run: async () => {
				await applyKeyboard(keyboardGoal);
				keyboardDirty = false;
			},
		},
		{
			dirty: () => cameraDirty,
			run: async () => {
				await applyCamera(baselineCamera());
				cameraDirty = false;
			},
		},
	];

	const internals: ConditionsInternals = {
		declared,
		dirty: () =>
			networkDirty ||
			locationDirty ||
			clockDirty ||
			permissionsDirty ||
			localeDirty ||
			a11yDirty ||
			batteryDirty ||
			keyboardDirty ||
			cameraDirty ||
			runs.size > 0,
		wantsInject: () =>
			baseline.network !== undefined ||
			baseline.clock !== undefined ||
			currentNetwork.kind !== "online" ||
			currentClock.kind !== "real",
		async applyBaseline() {
			for (const step of baselineSteps) await step();
			cameraDirty = false;
			networkDirty = false;
			locationDirty = false;
			clockDirty = false;
			permissionsDirty = false;
			localeDirty = false;
			a11yDirty = false;
			batteryDirty = false;
			keyboardDirty = false;
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
			for (const step of teardownSteps) {
				if (step.dirty()) await attempt(step.run);
			}
			if (errors.length > 0) throw errors[0];
		},
	};

	return {
		network: networkApi,
		location: locationApi,
		clock: clockApi,
		permissions: permissionsApi,
		timezone: applyTimezone,
		locale: applyLocale,
		a11y: applyA11y,
		battery: applyBattery,
		keyboard: applyKeyboard,
		camera: cameraApi,
		memoryWarning: async (options) => {
			const op = settingOp("memoryWarning");
			await call("memoryWarning", () => op(options ?? { bundleId: env.bundleId }));
		},
		push: async (payload, options) => {
			const op = settingOp("push");
			await call("push", () => op(payload, options ?? { bundleId: env.bundleId }));
		},
		timeline: startTimelineRun,
		internals,
	};
}
