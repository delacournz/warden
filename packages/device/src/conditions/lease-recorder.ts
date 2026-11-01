import type { ConditionArea, ConditionValues } from "@delacour/warden-config/conditions.types";
import { leaseConditions } from "@delacour/warden-core/conditions/conditions";
import { liveness, type PidAlive } from "@delacour/warden-store/liveness";
import { type StoreOpener, sharedStoreOpener } from "./lease-store";

/**
 * Writes what a spec changed on its device to the lease (`lease_conditions`), so `warden release` / gc can undo it
 * when the spec process dies before its own teardown. Best effort: a failure is logged and never reaches the test.
 */
export type ConditionRecorder = {
	/** the device now has `value` in `area` */
	record<A extends ConditionArea>(area: A, value: ConditionValues[A]): void;
	/**
	 * the device is back at its baseline `value`: when that is `neutral` (nothing to undo) the area is forgotten,
	 * unless a process is still held for it (a live shaping proxy), which release must still stop
	 */
	settle<A extends ConditionArea>(area: A, value: ConditionValues[A], neutral: boolean): void;
};

export type LeaseRecorderOptions = {
	leaseId: string;
	openStore?: StoreOpener;
	now?: () => number;
	log?: (line: string) => void;
	pidAlive?: PidAlive;
};

/** The {@link ConditionRecorder} over the lease store. */
export class LeaseRecorder implements ConditionRecorder {
	private readonly stderrLog = (line: string): void => {
		process.stderr.write(`${line}\n`);
	};

	private readonly open: StoreOpener;
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	private readonly alive: PidAlive;

	constructor(private readonly options: LeaseRecorderOptions) {
		this.open = options.openStore ?? sharedStoreOpener.opener();
		this.now = options.now ?? Date.now;
		this.log = options.log ?? this.stderrLog;
		this.alive = options.pidAlive ?? liveness.processAlive;
	}

	record<A extends ConditionArea>(area: A, value: ConditionValues[A]): void {
		try {
			const store = this.open();
			if (!store.success) {
				this.failed(area, store.error);
				return;
			}
			const recorded = leaseConditions.record(store.data, this.options.leaseId, area, value, this.now());
			if (!recorded.success) this.failed(area, recorded.error);
		} catch (error) {
			this.failed(area, error instanceof Error ? error.message : String(error));
		}
	}

	settle<A extends ConditionArea>(area: A, value: ConditionValues[A], neutral: boolean): void {
		try {
			const store = this.open();
			if (!store.success) {
				this.failed(area, store.error);
				return;
			}
			const row = leaseConditions.active(store.data, this.options.leaseId).find((r) => r.area === area);
			const held = row?.owned.some((p) => this.alive(p.pid)) ?? false;
			if (neutral && !held) {
				leaseConditions.clear(store.data, this.options.leaseId, area);
				return;
			}
			const recorded = leaseConditions.record(store.data, this.options.leaseId, area, value, this.now());
			if (!recorded.success) this.failed(area, recorded.error);
		} catch (error) {
			this.failed(area, error instanceof Error ? error.message : String(error));
		}
	}

	private failed(area: ConditionArea, reason: string): void {
		this.log(`[warden-e2e] could not record the ${area} condition on lease ${this.options.leaseId}: ${reason}`);
	}
}

/** Picks the recorder for a spec's environment. */
export class LeaseRecorderResolver {
	/** The recorder for a spec under a lease; none without `WARDEN_LEASE_ID` (a bare `bun test` has no lease to record on). */
	forEnv(env: { leaseId?: string }): ConditionRecorder | undefined {
		return env.leaseId === undefined ? undefined : new LeaseRecorder({ leaseId: env.leaseId });
	}
}

export const leaseRecorderResolver = new LeaseRecorderResolver();
