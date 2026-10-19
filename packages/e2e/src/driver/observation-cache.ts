import type { AlertInfo, Driver, DriverResult, Platform, Snapshot } from "./driver.types";
import { noteSpanDetail } from "./span-detail";

/**
 * A short-lived memory of the last whole-screen snapshot, so a read that follows another with no input in between
 * does not walk the screen again (`isVisible()` then `text()` was two snapshots; on Android each one is a ~1.9 s
 * `uiautomator dump`).
 *
 * It is a `Driver` wrapper, because every layer that can change the screen (`screen`, `app`, `device`, flows) shares
 * the one driver: whatever calls it, an input moves the *generation* on and the kept snapshot dies with the old one.
 * A snapshot is also dropped once it is older than the platform's max age, input or not (the app can change by itself).
 * Which reads may reuse one is the caller's call (`observe({ reuse })`): only the first look of a wait does, so a
 * poll never spins on a tree that stopped being true.
 */

/** How old a kept snapshot may be and still answer a read. iOS reads cost ~100-300 ms; an Android dump takes ~1.9 s. */
export const OBSERVATION_MAX_AGE_MS: Record<Platform, number> = { ios: 150, android: 1000 };

/** Optional capability of the cached driver, next to the frozen `Driver` (pattern: `SelectsAll` in `typing.ts`). */
export type Observes = {
	/** the whole screen: the kept snapshot when `reuse` and it is still good, else a new one (which is then kept) */
	observe(options: { reuse: boolean }): DriverResult<Snapshot>;
	/** forgets the kept snapshot: the next `observe` reads the device */
	invalidateObservations(): void;
	/**
	 * The look before the next one, for an action's stability rule (a frame that held still across two looks). Never
	 * used to answer a read: the kept snapshot is returned whatever its age.
	 */
	previous?(): PreviousLook;
	/**
	 * The kept snapshot and its age, when no input came since it was taken (whatever its age; the caller judges). Never
	 * reads the device. For a tap that checks a young kept snapshot with a hit-test instead of taking a new one.
	 */
	peek?(): KeptLook | undefined;
};

export type KeptLook = { snapshot: Snapshot; ageMs: number };

export type PreviousLook = {
	/** the kept snapshot, when no input came since it was taken (whatever its age) */
	snapshot: Snapshot | undefined;
	/** the input generation now: two answers with the same number had no input between them */
	generation: number;
	/** ms since the last input ended; undefined before any input */
	sinceInputMs: number | undefined;
};

export function canObserve(driver: Driver): driver is Driver & Observes {
	return typeof (driver as Partial<Observes>).observe === "function";
}

/**
 * Optional capability: the system alert, worked out from a snapshot already taken (Android: alerts are windows in the
 * dump). With it the cache answers `alert()` from the kept snapshot instead of dumping the screen again.
 */
export type DetectsAlerts = { alertIn(snapshot: Snapshot): AlertInfo | null };

export function canDetectAlerts(driver: Driver): driver is Driver & DetectsAlerts {
	return typeof (driver as Partial<DetectsAlerts>).alertIn === "function";
}

export type ObservationCacheOptions = {
	/** time source (ms); default `Date.now` */
	now?: () => number;
	/** default `OBSERVATION_MAX_AGE_MS` for the driver's platform */
	maxAgeMs?: number;
};

/** Calls that only look: they leave what is kept alone. Everything else, a capability nobody has heard of included, is input. */
const READS: ReadonlySet<string> = new Set([
	"health",
	"snapshot",
	"elementAtPoint",
	"screenshot",
	"alert",
	"alertOn",
	"alertIn",
	"isFrontmost",
	"isInstalled",
	"isRunning",
	"observe",
	"invalidateObservations",
	"previous",
	"peek",
]);

/** Look when called with no argument, change something when given one (`orientation()` vs `orientation("landscapeLeft")`). */
const READS_WITHOUT_ARGUMENT: ReadonlySet<string> = new Set(["orientation", "appearance", "clipboard"]);

type Kept = {
	snapshot: Snapshot;
	generation: number;
	at: number;
	/** this snapshot has answered an `alert()` already: a second one reads the device (a loop watching for a sheet) */
	alertRead: boolean;
};

type Call = (...args: unknown[]) => unknown;

function isCall(value: unknown): value is Call {
	return typeof value === "function";
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

/** A snapshot of the whole screen, as opposed to one the caller filtered. */
function isWholeScreen(options: Parameters<Driver["snapshot"]>[0]): boolean {
	return options === undefined || (options.interactiveOnly !== true && options.backend === undefined);
}

/**
 * Wraps `driver` (a `Proxy`: every member, optional capabilities included, reads through unchanged) with the
 * observation cache and the {@link Observes} capability. Put it outside the tracing wrapper, so a snapshot that was
 * served from memory leaves no `driver.snapshot` span.
 */
export function cacheObservations<D extends Driver>(driver: D, options: ObservationCacheOptions = {}): D & Observes {
	const now = options.now ?? Date.now;
	const maxAgeMs = options.maxAgeMs ?? OBSERVATION_MAX_AGE_MS[driver.platform];
	let generation = 0;
	let kept: Kept | undefined;
	let lastInputAt: number | undefined;

	const moveOn = (): void => {
		generation += 1;
		kept = undefined;
	};

	/** an input starts or ends: the generation moves on and the time is noted */
	const inputEdge = (): void => {
		moveOn();
		lastInputAt = now();
	};

	const previous = (): PreviousLook => ({
		snapshot: kept !== undefined && kept.generation === generation ? kept.snapshot : undefined,
		generation,
		sinceInputMs: lastInputAt === undefined ? undefined : now() - lastInputAt,
	});

	const peek = (): KeptLook | undefined =>
		kept !== undefined && kept.generation === generation
			? { snapshot: kept.snapshot, ageMs: now() - kept.at }
			: undefined;

	const usable = (): Kept | undefined =>
		kept !== undefined && kept.generation === generation && now() - kept.at < maxAgeMs ? kept : undefined;

	/** Keeps `snapshot` unless an input landed while it was being taken (it may predate that input). */
	const keep = (snapshot: Snapshot, startedIn: number): Kept | undefined => {
		if (startedIn !== generation) return undefined;
		kept = { snapshot, generation, at: now(), alertRead: false };
		return kept;
	};

	const observe: Observes["observe"] = async ({ reuse }) => {
		const hit = reuse ? usable() : undefined;
		if (hit !== undefined) {
			noteSpanDetail("observation", "cached");
			return { success: true, data: hit.snapshot };
		}
		const startedIn = generation;
		const taken = await driver.snapshot();
		if (taken.success) keep(taken.data, startedIn);
		return taken;
	};

	const snapshot: Driver["snapshot"] = async (opts) => {
		const startedIn = generation;
		const taken = await driver.snapshot(opts);
		if (taken.success && isWholeScreen(opts)) keep(taken.data, startedIn);
		return taken;
	};

	const alertFromSnapshot = (reader: Driver & DetectsAlerts): Driver["alert"] => {
		return async () => {
			const hit = usable();
			if (hit !== undefined && !hit.alertRead) {
				hit.alertRead = true;
				return { success: true, data: reader.alertIn(hit.snapshot) };
			}
			const startedIn = generation;
			const taken = await driver.snapshot();
			if (!taken.success) return taken;
			const fresh = keep(taken.data, startedIn);
			if (fresh !== undefined) fresh.alertRead = true;
			return { success: true, data: reader.alertIn(taken.data) };
		};
	};

	/** `fn`, with the kept snapshot dropped before it starts and after it ends, however it ends. */
	const asInput = (fn: Call, target: object): Call => {
		return (...args) => {
			inputEdge();
			let result: unknown;
			try {
				result = Reflect.apply(fn, target, args);
			} catch (error) {
				inputEdge();
				throw error;
			}
			if (!isThenable(result)) {
				inputEdge();
				return result;
			}
			return Promise.resolve(result).finally(inputEdge);
		};
	};

	/** What a member becomes: reads stay as they are, anything else is input, `orientation()` is a read only without an argument. */
	const wrapMember = (name: string, value: unknown, target: object): unknown => {
		if (name === "app" && typeof value === "object" && value !== null) return wrap(value, {});
		if (!isCall(value) || READS.has(name)) return value;
		const input = asInput(value, target);
		if (!READS_WITHOUT_ARGUMENT.has(name)) return input;
		return (...args: unknown[]): unknown =>
			args[0] === undefined ? Reflect.apply(value, target, args) : input(...args);
	};

	const wrap = <O extends object>(target: O, own: Readonly<Record<string, unknown>>): O => {
		const wrapped = new Map<string, { source: unknown; wrapper: unknown }>();
		return new Proxy(target, {
			get(object, property) {
				const value: unknown = Reflect.get(object, property, object);
				if (typeof property !== "string") return value;
				if (property in own) return own[property];
				const cached = wrapped.get(property);
				if (cached !== undefined && cached.source === value) return cached.wrapper;
				const wrapper = wrapMember(property, value, object);
				wrapped.set(property, { source: value, wrapper });
				return wrapper;
			},
		});
	};

	const own: Record<string, unknown> = { observe, invalidateObservations: moveOn, previous, peek, snapshot };
	if (canDetectAlerts(driver)) own.alert = alertFromSnapshot(driver);
	return wrap(driver, own) as D & Observes;
}
