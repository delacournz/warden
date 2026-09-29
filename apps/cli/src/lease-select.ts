import type { Lease } from "@warden/core/types";
import { resolveOwner, sessionOwner } from "./claim-flags";
import type { CommandContext } from "./context";

/** `<leaseId…> | --udid X | --mine | --session S` — shared by release + heartbeat. */
export type LeaseSelector = { ids: string[]; udids: string[]; mine: boolean; session?: string };

export const SELECT_OPTIONS = {
	udid: { type: "string", multiple: true },
	mine: { type: "boolean" },
	session: { type: "string" },
} as const;

export type Selection = { leases: Lease[]; unknown: string[] };

export function isEmptySelector(selector: LeaseSelector): boolean {
	return selector.ids.length === 0 && selector.udids.length === 0 && !selector.mine && selector.session === undefined;
}

function byIds(ctx: CommandContext, ids: string[], unknown: string[]): Lease[] {
	const store = ctx.store();
	return ids.flatMap((id) => {
		const lease = store.getLease(id);
		if (!lease) unknown.push(id);
		return lease ? [lease] : [];
	});
}

function byUdids(ctx: CommandContext, udids: string[], unknown: string[]): Lease[] {
	if (udids.length === 0) return [];
	const all = ctx.store().listLeases();
	return udids.flatMap((udid) => {
		const hits = all.filter((l) => l.resource.kind === "device" && l.resource.id === udid);
		if (hits.length === 0) unknown.push(udid);
		return hits;
	});
}

/** Resolve a selector to leases (deduplicated). Unknown ids / udids are reported, not fatal. */
export function selectLeases(ctx: CommandContext, selector: LeaseSelector): Selection {
	const store = ctx.store();
	const unknown: string[] = [];
	const leases = [
		...byIds(ctx, selector.ids, unknown),
		...byUdids(ctx, selector.udids, unknown),
		...(selector.mine ? store.listLeasesByOwner(resolveOwner(ctx)) : []),
		...(selector.session !== undefined ? store.listLeasesByOwner(sessionOwner(selector.session)) : []),
	];
	return { leases: [...new Map(leases.map((l) => [l.id, l])).values()], unknown };
}

/** `parseArgs` values of `SELECT_OPTIONS` + positionals → selector. */
export function selectorFrom(
	positionals: string[],
	values: { udid?: string[]; mine?: boolean; session?: string }
): LeaseSelector {
	return {
		ids: positionals,
		udids: values.udid ?? [],
		mine: values.mine === true,
		...(values.session !== undefined ? { session: values.session } : {}),
	};
}
