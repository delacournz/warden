import {
	type AxRecoveryRecord,
	type WarmConnect,
	type Warmed,
	type WarmHelper,
	type WarmOutcome,
	type WarmRun,
	warmDrivers,
} from "./warm-drivers";

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

/** One device's warm-up once it settled: its socket and helper when warm, its (held back) warning when not; `{}` for a device never warmed. */
export type DeviceWarm = {
	socketPath?: string;
	helper?: WarmHelper;
	warning?: string;
	error?: string;
	axRecovery?: AxRecoveryRecord;
};

/**
 * The iOS driver warm-up started while the run is still claiming: a leg's helpers are spawned and
 * snapshotted the moment its devices are leased, in parallel with the app install, Metro and the
 * per-device setup, instead of after all of them. A leg's devices warm one after the other (see
 * `warmDrivers`), and so do the legs: a leg's warm-up waits for the earlier-leased legs', because separate
 * legs warming at once contend for the host exactly as the devices of one would. The warm-up as a whole still
 * overlaps the install, Metro and setup.
 */
export type EarlyWarm = {
	/** `LeaseArgs.onLeased`: warm the devices of leg `leg` (their workers are numbered by leg order, as the run's pools are) */
	leased: (outcome: { claimed: ReadonlyArray<{ device: { id: string } }> }, leg: number) => void;
	/** every warm-up's outcome, once all have settled */
	settled: () => Promise<EarlyWarmOutcome>;
	/** one device's outcome as soon as it settled, without waiting for any other device (12-3); never rejects */
	device: (udid: string) => Promise<DeviceWarm>;
	/** one device's outcome if it has settled already */
	peek: (udid: string) => DeviceWarm | undefined;
	/** stop waiting for helpers still starting (a late one is closed) */
	abort: () => void;
	/**
	 * nothing else works on `udid` any more (its app install, setup and Metro launch are done, or it was dropped): only
	 * then may its warm-up reboot it (`WarmRun.quiet`)
	 */
	prepared: (udid: string) => void;
};

/** One settled device's `DeviceWarm` from its `Warmed` outcome, helper and held-back warning. */
function deviceWarm(warmed: Warmed, helper: WarmHelper | undefined, warning: string | undefined): DeviceWarm {
	return {
		...(warmed.socketPath !== undefined ? { socketPath: warmed.socketPath } : {}),
		...(helper ? { helper } : {}),
		...(warning !== undefined ? { warning } : {}),
		...(warmed.error !== undefined ? { error: warmed.error } : {}),
		...(warmed.axRecovery ? { axRecovery: warmed.axRecovery } : {}),
	};
}

/** Start the warm-up of the run's devices as they are leased; never throws. */
export function startEarlyWarm(deps: EarlyWarmDeps): EarlyWarm {
	const own = new AbortController();
	const signal = deps.signal ? AbortSignal.any([deps.signal, own.signal]) : own.signal;
	const warnings: string[] = [];
	const pending: Promise<WarmOutcome>[] = [];
	// the legs' warm-ups run in lease order: each starts when the one before it has settled (`warmDrivers` never rejects)
	let tail: Promise<unknown> = Promise.resolve();
	const firstWorker = (leg: number) => deps.legCounts.slice(0, leg).reduce((sum, n) => sum + n, 0);
	const byDevice = new Map<string, ReturnType<typeof Promise.withResolvers<DeviceWarm>>>();
	const done = new Map<string, DeviceWarm>();
	const quiet = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
	const quietOf = (udid: string) => {
		const known = quiet.get(udid);
		if (known) return known;
		const made = Promise.withResolvers<void>();
		quiet.set(udid, made);
		return made;
	};
	return {
		leased: (outcome, leg) => {
			const first = firstWorker(leg);
			for (const c of outcome.claimed) byDevice.set(c.device.id, Promise.withResolvers<DeviceWarm>());
			const run = tail.then(() =>
				warmDrivers(
					{
						devices: outcome.claimed.map((c, i) => ({ worker: first + i, udid: c.device.id })),
						logDir: deps.logDir,
						now: deps.now,
						after: deps.after,
						writeFile: deps.writeFile,
						signal,
						quiet: (udid) => quietOf(udid).promise,
					},
					{
						connect: deps.connect,
						warn: (line) => warnings.push(line),
						onDevice: (warmed, helper, warning) => {
							const outcome = deviceWarm(warmed, helper, warning);
							done.set(warmed.udid, outcome);
							byDevice.get(warmed.udid)?.resolve(outcome);
						},
						...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
					}
				)
			);
			pending.push(run);
			tail = run;
		},
		settled: async () => {
			const outcomes = await Promise.all(pending);
			return {
				devices: outcomes.flatMap((o) => o.devices).sort((a, b) => a.worker - b.worker),
				helpers: outcomes.flatMap((o) => o.helpers),
				warnings,
			};
		},
		device: (udid) => byDevice.get(udid)?.promise ?? Promise.resolve({}),
		peek: (udid) => done.get(udid),
		abort: () => own.abort(),
		prepared: (udid) => quietOf(udid).resolve(),
	};
}
