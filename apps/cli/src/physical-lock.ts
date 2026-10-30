import { isLeaseAlive, processAlive } from "@delacour/warden-core/liveness";
import { readLockState } from "@delacour/warden-core/providers/devicectl";
import { realTimer } from "@delacour/warden-core/providers/health";
import {
	DEVICE_LOCKED_CODE,
	DEVICE_LOCKED_HINT,
	isDeviceLockedError,
	waitUnlocked,
} from "@delacour/warden-core/providers/unlock-wait";
import { type DeviceRequest, isPhysicalReady, type Owner } from "@delacour/warden-core/types";
import { type AsyncResult, ok } from "@delacour/warden-types/result";
import type { CommandContext } from "./context";
import { reportError } from "./output";
import { providerFor } from "./providers";

/** A phone about to be claimed: its CoreDevice UDID and the name the person knows it by. */
type Phone = { id: string; name: string };

/**
 * The iPhones/iPads this claim is about to take: the named ones (`--udid`, `physical.ids`) that are ready, else the
 * one ready, unleased, allowlisted phone an id-less claim would pick. Several candidates mean the claim chooses
 * (and the picker has normally named one already), so none is waited on. An inventory that fails is the claim's to report.
 */
async function phonesToClaim(ctx: CommandContext, owner: Owner, request: DeviceRequest): Promise<Phone[]> {
	const ids = request.physical?.ids;
	const inventory = await providerFor("ios", ctx, owner, {
		physical: true,
		...(ids ? { namedPhysical: ids } : {}),
	}).inventory();
	if (!inventory.success) return [];
	const ready = inventory.data.filter((d) => d.platform === "ios" && isPhysicalReady(d));
	if (ids) return ready.filter((d) => ids.includes(d.id)).map(({ id, name }) => ({ id, name }));
	const now = ctx.now();
	const held = new Set(
		ctx
			.store()
			.listLeases()
			.flatMap((l) => (l.resource.kind === "device" && isLeaseAlive(l, now, processAlive) ? [l.resource.id] : []))
	);
	const allow = request.physical?.allow;
	const free = ready.filter((d) => !held.has(d.id) && (allow === undefined || allow.includes(d.id)));
	const only = free[0];
	return free.length === 1 && only ? [{ id: only.id, name: only.name }] : [];
}

export type UnlockOptions = {
	/** `--no-wait`: fail `device_locked` at once */
	noWait: boolean;
	/** polled between reads: true ends the wait with the claim's abort error */
	abort?: () => boolean;
	/** the wait between two reads (tests; default: real time) */
	sleep?: (ms: number) => Promise<void>;
};

/**
 * Before a physical iPhone is claimed (named or picked): if it is locked, say so on stderr and wait for the person
 * to unlock it, up to `UNLOCK_WAIT_MS`. Runs before any lease is taken and holds no store lock, so a waiting claim
 * blocks nobody. Not a physical iOS claim, or a phone that is unlocked or does not answer: nothing happens. A phone
 * still locked is the error `device_locked: <name> is locked`.
 */
export async function awaitPhonesUnlocked(
	ctx: CommandContext,
	owner: Owner,
	request: DeviceRequest,
	options: UnlockOptions
): AsyncResult<void> {
	if (request.platform !== "ios" || request.physical === undefined) return ok(undefined);
	for (const phone of await phonesToClaim(ctx, owner, request)) {
		const waited = await waitUnlocked({
			name: phone.name,
			noWait: options.noWait,
			read: () => readLockState({ exec: ctx.exec, timer: realTimer }, phone.id),
			now: ctx.now,
			sleep: options.sleep ?? Bun.sleep,
			log: (line) => ctx.err(`warden: ${line}`),
			...(options.abort ? { abort: options.abort } : {}),
		});
		if (!waited.success) return waited;
	}
	return ok(undefined);
}

const PREFIX = `${DEVICE_LOCKED_CODE}: `;

/** Is `error` the claim's own locked-phone failure (it starts with `device_locked: `)? */
export const isLockedClaimError = (error: string): boolean => error.startsWith(PREFIX) && isDeviceLockedError(error);

/** The message of a locked-phone claim error, without its code. */
export const lockedClaimMessage = (error: string): string => error.slice(PREFIX.length);

/**
 * Report a failed claim for command `scope` and return its exit code: 2 for a phone that stayed locked (the `--json`
 * envelope carries `device_locked` and the hint), 1 otherwise.
 */
export function reportClaimFailure(ctx: CommandContext, scope: string, error: string): 1 | 2 {
	if (!isLockedClaimError(error)) {
		reportError(ctx, scope, error);
		return 1;
	}
	const message = lockedClaimMessage(error);
	ctx.failure?.record(message, { code: DEVICE_LOCKED_CODE, hint: DEVICE_LOCKED_HINT });
	ctx.err(ctx.ui.color.red(`warden ${scope}: ${message}`));
	ctx.err(ctx.ui.color.dim(DEVICE_LOCKED_HINT));
	return 2;
}
