import { readFile } from "node:fs/promises";
import type { LatLon } from "@delacour/warden-config/conditions.types";
import type { ClockRecorder } from "./clock-recorder";
import type { ConditionSink } from "./conditions/condition-events";
import { locationPlanner } from "./conditions/location-plan";
import { type RouteTicker, realTickerClock, routeTickers, type TickerClock } from "./conditions/route-ticker";
import { type Scheduler, schedulers } from "./conditions/scheduler";
import type { Driver, DriverError, DriverResult, Logger, Snapshot } from "./driver.types";
import { driverErrors } from "./errors";
import { DEFAULT_SETTLE_QUIET_MS, DEFAULT_SETTLE_TIMEOUT_MS, type SettleDetail, settler } from "./settle";
import { spanDetails } from "./trace/span-detail";

/** Thrown inside a hash poll so the settle can return the snapshot's own error; never escapes {@link BaseDriver.settle}. */
export class DriverFailure extends Error {
	constructor(readonly error: DriverError) {
		super(error.message);
	}
}

/** What a settle answers once awaited. */
export type SettleResult = Awaited<DriverResult<SettleDetail>>;

export type BaseDriverOptions = {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	log?: Logger;
	/** pacing of in-process flaps and location routes (default real time); tests pass a fake */
	tickerClock?: TickerClock;
	/** told about every network flap transition (the `condition` events of `results.jsonl`) */
	conditionSink?: ConditionSink;
	/** told about every successful `clock` op, so the lease records the `clock` area */
	clockRecorder?: ClockRecorder;
	/** quiet window and budget of a `settle` that names neither (default {@link DEFAULT_SETTLE_QUIET_MS} / {@link DEFAULT_SETTLE_TIMEOUT_MS}) */
	settleDefaults?: { quietMs: number; timeoutMs: number };
};

/**
 * What the platform drivers share: snapshot-hash `settle` with an optional native settle first, the in-process
 * network flap and location route schedulers, the clock recorder, and the `close()` order. A subclass supplies
 * `takeSnapshot` and overrides the `protected` hooks it has a mechanism for; a hook left alone answers
 * `E_UNSUPPORTED` (conditions) or does nothing (`stopHelper`, `restoreSettings`, `teardown`).
 *
 * The ops are arrow-function properties (own, enumerable, detachable) so a wrapper may spread or proxy them; a
 * subclass whose platform does it differently assigns its own property of the same name.
 */
export abstract class BaseDriver {
	abstract readonly platform: Driver["platform"];
	abstract readonly id: string;

	/** saves still in flight (state file writes); `close()` waits for them */
	protected readonly saving: Promise<void>[] = [];
	protected readonly base: BaseDriverOptions;
	private flapper: Scheduler | undefined;
	private ticker: RouteTicker | undefined;

	constructor(base: BaseDriverOptions) {
		this.base = base;
	}

	/** The current screen, for the hash settle. */
	protected abstract takeSnapshot(): DriverResult<Snapshot>;

	/** The platform's own settle; `undefined` means it has none (or cannot now) and the hash poll runs. */
	protected async nativeSettle(_o: { quietMs: number; timeoutMs: number }): Promise<SettleResult | undefined> {
		return undefined;
	}

	/** The fingerprint a hash poll compares. */
	protected hashSnapshot(snapshot: Snapshot): string {
		return settler.snapshotHash(snapshot);
	}

	/** One hash poll; a failed snapshot throws {@link DriverFailure}. */
	protected async pollHash(): Promise<string> {
		const taken = await this.takeSnapshot();
		if (!taken.success) throw new DriverFailure(taken.error);
		return this.hashSnapshot(taken.data);
	}

	/** Puts the device's network into `op` (never a flap: the base runs those). */
	protected async applyNetwork(
		_op: Parameters<Driver["network"]>[0],
		_opts?: Parameters<Driver["network"]>[1]
	): ReturnType<Driver["network"]> {
		return this.unsupportedOp("network");
	}

	protected async applyClock(
		_op: Parameters<Driver["clock"]>[0],
		_opts?: Parameters<Driver["clock"]>[1]
	): ReturnType<Driver["clock"]> {
		return this.unsupportedOp("clock");
	}

	/** One location fix; the base plays routes as a series of these. */
	protected async setLocationFix(_point: LatLon, _altM?: number): DriverResult<void> {
		return this.unsupportedOp("location");
	}

	/** An error that refuses every location op on this device, else undefined. */
	protected locationGuard(): DriverError | undefined {
		return undefined;
	}

	protected readText(path: string): Promise<string> {
		return readFile(path, "utf8");
	}

	/** Stops the platform's resident helper process. */
	protected async stopHelper(): Promise<void> {}

	/** Puts back what the driver changed on open (animation scales, rotation lock). */
	protected async restoreSettings(): Promise<void> {}

	/** Closes the transport, last. */
	protected async teardown(): Promise<void> {}

	readonly settle: Driver["settle"] = async (o) => {
		const quietMs = o?.quietMs ?? this.base.settleDefaults?.quietMs ?? DEFAULT_SETTLE_QUIET_MS;
		const timeoutMs = o?.timeoutMs ?? this.base.settleDefaults?.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
		const native = await this.nativeSettle({ quietMs, timeoutMs });
		if (native) return native;
		return this.hashSettle(quietMs, timeoutMs);
	};

	/**
	 * Any network op ends a running flap first (which puts its base back). `flap` itself applies the base, then
	 * the scheduler alternates it with offline in this process until the next network op or `close()`.
	 */
	readonly network: Driver["network"] = async (op, opts) => {
		await this.stopFlap();
		if (op.kind !== "flap") return this.applyNetwork(op, opts);
		const base = op.base ?? { kind: "online" };
		if (base.kind === "flap") return driverErrors.err("E_BAD_REQUEST", "flap base cannot itself be a flap");
		if (!(op.upMs > 0 && op.downMs > 0)) return driverErrors.err("E_BAD_REQUEST", "flap needs upMs and downMs above 0");
		const applied = await this.applyNetwork(base, opts);
		if (!applied.success) return applied;
		const running = schedulers.startFlap(
			{ network: (condition) => this.applyNetwork(condition, opts) },
			{ ...op, base, applyInitial: false },
			{
				...(this.base.tickerClock ?? realTickerClock),
				...(this.base.conditionSink ? { sink: this.base.conditionSink } : {}),
			}
		);
		this.flapper = running;
		void running.done.then((outcome) => {
			if (outcome.stopped === "failed") this.base.log?.(`network flap stopped: ${outcome.error}`);
		});
		return { success: true, data: { ...applied.data, condition: op } };
	};

	/**
	 * A route is played by a ticker in this process until the next location op or `close()`. `clear` stops the
	 * ticker; whether the last fix stays is the platform's.
	 */
	readonly location: Driver["location"] = async (op) => {
		const refused = this.locationGuard();
		if (refused) return { success: false, error: refused };
		await this.stopTicker();
		if (op.kind === "clear") return { success: true, data: undefined };
		if (op.kind === "point") return this.setLocationFix(op, op.altM);
		const planned = await locationPlanner.planRoute(op, (path) => this.readText(path));
		if (!planned.success) return driverErrors.err("E_BAD_REQUEST", planned.error);
		const plan = planned.data;
		const first = plan.points[0] as LatLon;
		const placed = await this.setLocationFix(first);
		if (!placed.success || plan.points.length < 2) return placed;
		const running = routeTickers.start(plan, {
			...(this.base.tickerClock ?? realTickerClock),
			fix: async (point) => {
				const res = await this.setLocationFix(point);
				return res.success ? undefined : res.error.message;
			},
		});
		this.ticker = running;
		void running.done.then((outcome) => {
			if (outcome.stopped === "failed") this.base.log?.(`location route stopped: ${outcome.error}`);
		});
		return { success: true, data: undefined };
	};

	readonly clock: Driver["clock"] = async (op, opts) => {
		const applied = await this.applyClock(op, opts);
		if (applied.success) this.base.clockRecorder?.(op);
		return applied;
	};

	readonly close = async (): Promise<void> => {
		await this.stopFlap();
		await this.stopTicker();
		await this.stopHelper();
		await this.restoreSettings();
		await Promise.all(this.saving.splice(0));
		await this.teardown();
	};

	protected unsupportedOp(op: string) {
		return driverErrors.err("E_UNSUPPORTED", `${op} is not supported by this ${this.platform} driver`);
	}

	protected async stopFlap(): Promise<void> {
		const running = this.flapper;
		this.flapper = undefined;
		running?.stop();
		await running?.done;
	}

	protected async stopTicker(): Promise<void> {
		const running = this.ticker;
		this.ticker = undefined;
		running?.stop();
		await running?.done;
	}

	private async hashSettle(quietMs: number, timeoutMs: number): DriverResult<SettleDetail> {
		try {
			const outcome = await settler.byHash(() => this.pollHash(), {
				quietMs,
				timeoutMs,
				now: this.base.now,
				sleep: this.base.sleep,
			});
			spanDetails.note("via", "hash");
			return { success: true, data: { ...outcome, via: "hash" } };
		} catch (error) {
			if (error instanceof DriverFailure) return { success: false, error: error.error };
			throw error;
		}
	}
}
