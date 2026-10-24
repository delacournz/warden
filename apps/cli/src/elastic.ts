import type { BatchHandle, BatchWorker } from "@delacour/warden-core/batch/schedule";
import type { CapacityDeps } from "@delacour/warden-core/claim";
import { roomNow } from "@delacour/warden-core/room";
import type { Platform } from "@delacour/warden-core/types";
import type { AsyncResult } from "@delacour/warden-types/result";

/** How a run with N wanted workers splits: `first` now (they may queue), `extra` one by one later. */
export type ElasticPlan = { first: number; extra: number };

/**
 * Split `wanted` workers by what fits the host right now: claim `min(wanted, room)` (at least 1) up
 * front and the rest in the background. Undefined when everything fits (or capacity is off, or the room
 * cannot be read): the run claims all workers at once, as without capacity.
 */
export async function planElastic(
	capacity: CapacityDeps | undefined,
	platform: Platform,
	wanted: number
): Promise<ElasticPlan | undefined> {
	if (!capacity || wanted < 2) return undefined;
	const room = await roomNow(capacity, platform);
	if (!room.success || room.data >= wanted) return undefined;
	const first = Math.max(1, room.data);
	return { first, extra: wanted - first };
}

/** A worker claimed and prepared (installed, set up, warmed) after the run started. */
export type LateWorker = {
	worker: BatchWorker;
	/** give the device back: the run could not use it */
	drop: () => Promise<void>;
};

export type LateClaimOptions = {
	/** how many more workers to try for */
	count: number;
	/** the worker number the first late worker gets; later ones follow */
	firstWorker: number;
	handle: BatchHandle;
	/** the run's SIGINT / SIGTERM */
	signal: AbortSignal;
	/**
	 * Claim one device (queued at the run's late priority) and prepare it. `abort` turns true when the
	 * run no longer wants it (signal, or no job left); the claim then ends with an error.
	 */
	claim: (o: { worker: number; leg: number; abort: () => boolean }) => AsyncResult<LateWorker>;
	log: (line: string) => void;
};

export type LateClaimOutcome = { joined: number; dropped: number };

/**
 * Claim the remaining workers one at a time and add each to the running batch. Stops when the job
 * queue is empty, the run is aborted, a claim fails (reported once), or a worker arrives after the
 * queue drained (its lease is dropped). Never throws; every claimed device is either joined or dropped.
 */
export async function claimLateWorkers(o: LateClaimOptions): Promise<LateClaimOutcome> {
	const outcome: LateClaimOutcome = { joined: 0, dropped: 0 };
	const abort = () => o.signal.aborted || o.handle.pending() === 0;
	for (let i = 0; i < o.count && !abort(); i++) {
		const worker = o.firstWorker + outcome.joined;
		let claimed: Awaited<ReturnType<LateClaimOptions["claim"]>>;
		try {
			claimed = await o.claim({ worker, leg: outcome.joined + 1, abort });
		} catch (error) {
			o.log(`worker ${worker + 1}: ${error instanceof Error ? error.message : String(error)}`);
			break;
		}
		if (!claimed.success) {
			if (!abort()) o.log(`worker ${worker + 1} not added: ${claimed.error}`);
			break;
		}
		if (abort() || !o.handle.addWorker(claimed.data.worker)) {
			await claimed.data.drop().catch(() => {});
			outcome.dropped++;
			o.log(`worker ${worker + 1} released: the queue drained before it was ready`);
			break;
		}
		outcome.joined++;
	}
	return outcome;
}
