import type { GitFactsCache } from "@delacour/warden-runtime/git-facts";
import type { Store } from "@delacour/warden-store/store";
import type { Lease } from "@delacour/warden-store/types";
import { resolveOwner, sessionOwner } from "./owner";

/** `<leaseId…> | --udid X | --mine [--label L] | --session S` — shared by release + heartbeat. */
export type LeaseSelector = { ids: string[]; udids: string[]; mine: boolean; session?: string; label?: string };

export const NOTHING_SELECTED = "nothing selected — pass <leaseId…>, --udid, --mine or --session";

export type Selection = { leases: Lease[]; unknown: string[] };

/** What a selection reads: the store, and (for `mine`) who the caller is. */
export type SelectHost = {
	store: () => Store;
	env: Record<string, string | undefined>;
	cwd: string;
	git: GitFactsCache;
};

export function isEmptySelector(selector: LeaseSelector): boolean {
	return selector.ids.length === 0 && selector.udids.length === 0 && !selector.mine && selector.session === undefined;
}

function byIds(host: SelectHost, ids: string[], unknown: string[]): Lease[] {
	const store = host.store();
	return ids.flatMap((id) => {
		const lease = store.getLease(id);
		if (!lease) unknown.push(id);
		return lease ? [lease] : [];
	});
}

function byUdids(host: SelectHost, udids: string[], unknown: string[]): Lease[] {
	if (udids.length === 0) return [];
	const all = host.store().listLeases();
	return udids.flatMap((udid) => {
		const hits = all.filter((l) => l.resource.kind === "device" && l.resource.id === udid);
		if (hits.length === 0) unknown.push(udid);
		return hits;
	});
}

/** Resolve a selector to leases (deduplicated). Unknown ids / udids are reported, not fatal. */
export function selectLeases(host: SelectHost, selector: LeaseSelector): Selection {
	const store = host.store();
	const unknown: string[] = [];
	const leases = [
		...byIds(host, selector.ids, unknown),
		...byUdids(host, selector.udids, unknown),
		...(selector.mine
			? store
					.listLeasesByOwner(resolveOwner(host))
					.filter((l) => selector.label === undefined || l.label === selector.label)
			: []),
		...(selector.session !== undefined ? store.listLeasesByOwner(sessionOwner(selector.session)) : []),
	];
	return { leases: [...new Map(leases.map((l) => [l.id, l])).values()], unknown };
}
