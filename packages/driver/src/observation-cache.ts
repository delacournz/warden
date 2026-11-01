import type { AlertInfo, Driver, DriverResult, Platform, Snapshot } from "./driver.types";
import { spanDetails } from "./trace/span-detail";

/**
 * A short-lived memory of the last whole-screen snapshot, so a read that follows another with no input in between
 * does not walk the screen again (`isVisible()` then `text()` was two snapshots; on Android each one is a ~1.9 s
 * `uiautomator dump`).
 *
 * It is a `Driver` wrapper, because every layer that can change the screen (`screen`, `app`, `device`, specs) shares
 * the one driver: whatever calls it, an input moves the *generation* on and the kept snapshot dies with the old one.
 * A snapshot is also dropped once it is older than the platform's max age, input or not (the app can change by itself).
 * Which reads may reuse one is the caller's call (`observe({ reuse })`): only the first look of a wait does, so a
 * poll never spins on a tree that stopped being true. A `settle` is a wait, not an input: the kept snapshot predates
 * it and is dropped, but nothing was pressed, so `previous().sinceInputMs` still counts from the last real input; one
 * that reports `quiet` is the app's word that the input has landed, and then no input is recent at all.
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

/**
 * Optional capability: the system alert, worked out from a snapshot already taken (Android: alerts are windows in the
 * dump). With it the cache answers `alert()` from the kept snapshot instead of dumping the screen again.
 */
export type DetectsAlerts = { alertIn(snapshot: Snapshot): AlertInfo | null };

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

/** Calls that wait for the screen without touching it: what is kept predates them, but they are not input. */
const WAITS: ReadonlySet<string> = new Set(["settle"]);

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

/** The cache of one driver: the kept snapshot, the input generation, and the wrapper that feeds both. */
class ObservationSession<D extends Driver> {
	private generation = 0;
	private kept: Kept | undefined;
	private lastInputAt: number | undefined;
	private readonly now: () => number;
	private readonly maxAgeMs: number;

	constructor(
		private readonly driver: D,
		options: ObservationCacheOptions,
		private readonly caps: Observations
	) {
		this.now = options.now ?? Date.now;
		this.maxAgeMs = options.maxAgeMs ?? OBSERVATION_MAX_AGE_MS[driver.platform];
	}

	wrapped(): D & Observes {
		const own: Record<string, unknown> = {
			observe: this.observe,
			invalidateObservations: this.moveOn,
			previous: this.previous,
			peek: this.peek,
			snapshot: this.snapshot,
		};
		if (this.caps.canDetectAlerts(this.driver)) own.alert = this.alertFromSnapshot(this.driver);
		return this.wrap(this.driver, own) as D & Observes;
	}

	private readonly moveOn = (): void => {
		this.generation += 1;
		this.kept = undefined;
	};

	/** an input starts or ends: the generation moves on and the time is noted */
	private readonly inputEdge = (): void => {
		this.moveOn();
		this.lastInputAt = this.now();
	};

	private readonly previous = (): PreviousLook => ({
		snapshot: this.kept !== undefined && this.kept.generation === this.generation ? this.kept.snapshot : undefined,
		generation: this.generation,
		sinceInputMs: this.lastInputAt === undefined ? undefined : this.now() - this.lastInputAt,
	});

	private readonly peek = (): KeptLook | undefined =>
		this.kept !== undefined && this.kept.generation === this.generation
			? { snapshot: this.kept.snapshot, ageMs: this.now() - this.kept.at }
			: undefined;

	private usable(): Kept | undefined {
		const { kept } = this;
		return kept !== undefined && kept.generation === this.generation && this.now() - kept.at < this.maxAgeMs
			? kept
			: undefined;
	}

	/** Keeps `snapshot` unless an input landed while it was being taken (it may predate that input). */
	private keep(snapshot: Snapshot, startedIn: number): Kept | undefined {
		if (startedIn !== this.generation) return undefined;
		this.kept = { snapshot, generation: this.generation, at: this.now(), alertRead: false };
		return this.kept;
	}

	private readonly observe: Observes["observe"] = async ({ reuse }) => {
		const hit = reuse ? this.usable() : undefined;
		if (hit !== undefined) {
			spanDetails.note("observation", "cached");
			return { success: true, data: hit.snapshot };
		}
		const startedIn = this.generation;
		const taken = await this.driver.snapshot();
		if (taken.success) this.keep(taken.data, startedIn);
		return taken;
	};

	private readonly snapshot: Driver["snapshot"] = async (opts) => {
		const startedIn = this.generation;
		const taken = await this.driver.snapshot(opts);
		if (taken.success && this.isWholeScreen(opts)) this.keep(taken.data, startedIn);
		return taken;
	};

	/** A snapshot of the whole screen, as opposed to one the caller filtered. */
	private isWholeScreen(options: Parameters<Driver["snapshot"]>[0]): boolean {
		return options === undefined || (options.interactiveOnly !== true && options.backend === undefined);
	}

	private alertFromSnapshot(reader: Driver & DetectsAlerts): Driver["alert"] {
		return async () => {
			const hit = this.usable();
			if (hit !== undefined && !hit.alertRead) {
				hit.alertRead = true;
				return { success: true, data: reader.alertIn(hit.snapshot) };
			}
			const startedIn = this.generation;
			const taken = await this.driver.snapshot();
			if (!taken.success) return taken;
			const fresh = this.keep(taken.data, startedIn);
			if (fresh !== undefined) fresh.alertRead = true;
			return { success: true, data: reader.alertIn(taken.data) };
		};
	}

	/** A settle result that says the screen went quiet (`{ success: true, data: { quiet: true } }`). */
	private reportsQuiet(result: unknown): boolean {
		if (typeof result !== "object" || result === null || !("success" in result) || result.success !== true) {
			return false;
		}
		const data: unknown = "data" in result ? result.data : undefined;
		return typeof data === "object" && data !== null && "quiet" in data && data.quiet === true;
	}

	private isThenable(value: unknown): value is PromiseLike<unknown> {
		return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
	}

	private isCall(value: unknown): value is Call {
		return typeof value === "function";
	}

	/** `fn`, with `edge` run before it starts and after it ends, however it ends. */
	private edged(fn: Call, target: object, edge: () => void): Call {
		return (...args) => {
			edge();
			let result: unknown;
			try {
				result = Reflect.apply(fn, target, args);
			} catch (error) {
				edge();
				throw error;
			}
			if (!this.isThenable(result)) {
				edge();
				return result;
			}
			return Promise.resolve(result).finally(edge);
		};
	}

	/** `fn`, with the kept snapshot dropped before it starts and after it ends, and the input time noted. */
	private asInput(fn: Call, target: object): Call {
		return this.edged(fn, target, this.inputEdge);
	}

	/** `fn`, with the kept snapshot dropped before it starts and after it ends; no input happened, and a quiet answer ends the last one. */
	private asWait(fn: Call, target: object): Call {
		const waited = this.edged(fn, target, this.moveOn);
		return async (...args) => {
			const result: unknown = await waited(...args);
			if (this.reportsQuiet(result)) this.lastInputAt = undefined;
			return result;
		};
	}

	/** What a member becomes: reads stay as they are, anything else is input, `orientation()` is a read only without an argument. */
	private wrapMember(name: string, value: unknown, target: object): unknown {
		if (name === "app" && typeof value === "object" && value !== null) return this.wrap(value, {});
		if (!this.isCall(value) || READS.has(name)) return value;
		if (WAITS.has(name)) return this.asWait(value, target);
		const input = this.asInput(value, target);
		if (!READS_WITHOUT_ARGUMENT.has(name)) return input;
		return (...args: unknown[]): unknown =>
			args[0] === undefined ? Reflect.apply(value, target, args) : input(...args);
	}

	private wrap<O extends object>(target: O, own: Readonly<Record<string, unknown>>): O {
		const wrapped = new Map<string, { source: unknown; wrapper: unknown }>();
		return new Proxy(target, {
			get: (object, property) => {
				const value: unknown = Reflect.get(object, property, object);
				if (typeof property !== "string") return value;
				if (property in own) return own[property];
				const cached = wrapped.get(property);
				if (cached !== undefined && cached.source === value) return cached.wrapper;
				const wrapper = this.wrapMember(property, value, object);
				wrapped.set(property, { source: value, wrapper });
				return wrapper;
			},
		});
	}
}

/** Observation-cache capability checks and the driver wrapper. Use the shared {@link observations} singleton. */
export class Observations {
	canObserve(driver: Driver): driver is Driver & Observes {
		return typeof (driver as Partial<Observes>).observe === "function";
	}

	canDetectAlerts(driver: Driver): driver is Driver & DetectsAlerts {
		return typeof (driver as Partial<DetectsAlerts>).alertIn === "function";
	}

	/**
	 * Wraps `driver` (a `Proxy`: every member, optional capabilities included, reads through unchanged) with the
	 * observation cache and the {@link Observes} capability. Put it outside the tracing wrapper, so a snapshot that was
	 * served from memory leaves no `driver.snapshot` span.
	 */
	cache<D extends Driver>(driver: D, options: ObservationCacheOptions = {}): D & Observes {
		return new ObservationSession(driver, options, this).wrapped();
	}
}

export const observations = new Observations();
