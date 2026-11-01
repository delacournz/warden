import { hostDeps } from "@delacour/warden-core/host-deps";
import { Devicectl } from "@delacour/warden-providers/devicectl";
import { timers } from "@delacour/warden-providers/health";
import {
	DEVICE_LOCKED_CODE,
	DEVICE_LOCKED_HINT,
	deviceLockedErrors,
	UnlockWaiter,
} from "@delacour/warden-providers/unlock-wait";
import { liveness } from "@delacour/warden-store/liveness";
import { type DeviceRequest, leaseModel, type Owner } from "@delacour/warden-store/types";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { type CommandContext, contextBuilder } from "./context";
import { output } from "./output";

/** A phone about to be claimed: its CoreDevice UDID and the name the person knows it by. */
type Phone = { id: string; name: string };

export type UnlockOptions = {
	/** `--no-wait`: fail `device_locked` at once */
	noWait: boolean;
	/** polled between reads: true ends the wait with the claim's abort error */
	abort?: () => boolean;
	/** the wait between two reads (tests; default: real time) */
	sleep?: (ms: number) => Promise<void>;
};

const PREFIX = `${DEVICE_LOCKED_CODE}: `;

export class PhysicalLock {
	/**
	 * The iPhones/iPads this claim is about to take: the named ones (`--udid`, `physical.ids`) that are ready, else the
	 * one ready, unleased, allowlisted phone an id-less claim would pick. Several candidates mean the claim chooses
	 * (and the picker has normally named one already), so none is waited on. An inventory that fails is the claim's to report.
	 */
	private async phonesToClaim(ctx: CommandContext, owner: Owner, request: DeviceRequest): Promise<Phone[]> {
		const ids = request.physical?.ids;
		const inventory = await hostDeps
			.providerFor("ios", contextBuilder.appHostFromContext(ctx), owner, {
				physical: true,
				...(ids ? { namedPhysical: ids } : {}),
			})
			.inventory();
		if (!inventory.success) return [];
		const ready = inventory.data.filter((d) => d.platform === "ios" && leaseModel.isPhysicalReady(d));
		if (ids) return ready.filter((d) => ids.includes(d.id)).map(({ id, name }) => ({ id, name }));
		const now = ctx.now();
		const held = new Set(
			ctx
				.store()
				.listLeases()
				.flatMap((l) =>
					l.resource.kind === "device" && liveness.isLeaseAlive(l, now, liveness.processAlive) ? [l.resource.id] : []
				)
		);
		const allow = request.physical?.allow;
		const free = ready.filter((d) => !held.has(d.id) && (allow === undefined || allow.includes(d.id)));
		const only = free[0];
		return free.length === 1 && only ? [{ id: only.id, name: only.name }] : [];
	}

	/**
	 * Before a physical iPhone is claimed (named or picked): if it is locked, say so on stderr and wait for the person
	 * to unlock it, up to `UNLOCK_WAIT_MS`. Runs before any lease is taken and holds no store lock, so a waiting claim
	 * blocks nobody. Not a physical iOS claim, or a phone that is unlocked or does not answer: nothing happens. A phone
	 * still locked is the error `device_locked: <name> is locked`.
	 */
	async awaitPhonesUnlocked(
		ctx: CommandContext,
		owner: Owner,
		request: DeviceRequest,
		options: UnlockOptions
	): AsyncResult<void> {
		if (request.platform !== "ios" || request.physical === undefined) return resultFactory.ok(undefined);
		for (const phone of await this.phonesToClaim(ctx, owner, request)) {
			const waited = await new UnlockWaiter({
				name: phone.name,
				noWait: options.noWait,
				read: () => new Devicectl({ exec: ctx.exec, timer: timers.real }).readLockState(phone.id),
				now: ctx.now,
				sleep: options.sleep ?? Bun.sleep,
				log: (line) => ctx.err(`warden: ${line}`),
				...(options.abort ? { abort: options.abort } : {}),
			}).wait();
			if (!waited.success) return waited;
		}
		return resultFactory.ok(undefined);
	}

	/** Is `error` the claim's own locked-phone failure (it starts with `device_locked: `)? */
	isLockedClaimError(error: string): boolean {
		return error.startsWith(PREFIX) && deviceLockedErrors.isLocked(error);
	}

	/** The message of a locked-phone claim error, without its code. */
	lockedClaimMessage(error: string): string {
		return error.slice(PREFIX.length);
	}

	/**
	 * Report a failed claim for command `scope` and return its exit code: 2 for a phone that stayed locked (the `--json`
	 * envelope carries `device_locked` and the hint), 1 otherwise.
	 */
	reportClaimFailure(ctx: CommandContext, scope: string, error: string): 1 | 2 {
		if (!this.isLockedClaimError(error)) {
			output.reportError(ctx, scope, error);
			return 1;
		}
		const message = this.lockedClaimMessage(error);
		ctx.failure?.record(message, { code: DEVICE_LOCKED_CODE, hint: DEVICE_LOCKED_HINT });
		ctx.err(ctx.ui.color.red(`warden ${scope}: ${message}`));
		ctx.err(ctx.ui.color.dim(DEVICE_LOCKED_HINT));
		return 2;
	}
}

export const physicalLock = new PhysicalLock();
