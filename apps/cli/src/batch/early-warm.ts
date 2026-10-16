import { type WarmConnect, type WarmOutcome, type WarmRun, warmDrivers } from "./warm-drivers";

/** What the early warm-up needs: the `warmDrivers` effects plus the run's shape. */
export type EarlyWarmDeps = Pick<WarmRun, "logDir" | "now" | "after" | "writeFile"> & {
	connect: WarmConnect;
	/** how many devices each leg claims, in leg order: the worker numbers the legs will get */
	legCounts: readonly number[];
	/** the run's SIGINT: stop waiting for helpers that are still starting */
	signal?: AbortSignal;
	timeoutMs?: number;
};

/** `WarmOutcome` with the warm-up's warnings held back, so a run that is torn down prints none. */
export type EarlyWarmOutcome = WarmOutcome & { warnings: string[] };

/**
 * The iOS driver warm-up started while the run is still claiming: a leg's helpers are spawned and
 * snapshotted the moment its devices are leased, in parallel with the app install, Metro and the
 * per-device setup, instead of after all of them.
 */
export type EarlyWarm = {
	/** `LeaseArgs.onLeased`: warm the devices of leg `leg` (their workers are numbered by leg order, as the run's pools are) */
	leased: (outcome: { claimed: ReadonlyArray<{ device: { id: string } }> }, leg: number) => void;
	/** every warm-up's outcome, once all have settled */
	settled: () => Promise<EarlyWarmOutcome>;
	/** stop waiting for helpers still starting (a late one is closed) */
	abort: () => void;
};

/** Start the warm-up of the run's devices as they are leased; never throws. */
export function startEarlyWarm(deps: EarlyWarmDeps): EarlyWarm {
	const own = new AbortController();
	const signal = deps.signal ? AbortSignal.any([deps.signal, own.signal]) : own.signal;
	const warnings: string[] = [];
	const pending: Promise<WarmOutcome>[] = [];
	const firstWorker = (leg: number) => deps.legCounts.slice(0, leg).reduce((sum, n) => sum + n, 0);
	return {
		leased: (outcome, leg) => {
			const first = firstWorker(leg);
			pending.push(
				warmDrivers(
					{
						devices: outcome.claimed.map((c, i) => ({ worker: first + i, udid: c.device.id })),
						logDir: deps.logDir,
						now: deps.now,
						after: deps.after,
						writeFile: deps.writeFile,
						signal,
					},
					{
						connect: deps.connect,
						warn: (line) => warnings.push(line),
						...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
					}
				)
			);
		},
		settled: async () => {
			const outcomes = await Promise.all(pending);
			return {
				devices: outcomes.flatMap((o) => o.devices).sort((a, b) => a.worker - b.worker),
				helpers: outcomes.flatMap((o) => o.helpers),
				warnings,
			};
		},
		abort: () => own.abort(),
	};
}
