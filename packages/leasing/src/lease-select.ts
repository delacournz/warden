import type { GitFactsCache } from "@delacour/warden-runtime/git-facts";
import type { Store } from "@delacour/warden-store/store";
import type { Lease } from "@delacour/warden-store/types";
import { ownerResolver } from "./owner";

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

/** Pure checks on a selector, usable before a host exists. */
export class LeaseSelectorRules {
	isEmpty(selector: LeaseSelector): boolean {
		return selector.ids.length === 0 && selector.udids.length === 0 && !selector.mine && selector.session === undefined;
	}
}

export const leaseSelectorRules = new LeaseSelectorRules();

export class LeaseSelection {
	constructor(private readonly host: SelectHost) {}

	/** Resolve a selector to leases (deduplicated). Unknown ids / udids are reported, not fatal. */
	select(selector: LeaseSelector): Selection {
		const store = this.host.store();
		const unknown: string[] = [];
		const leases = [
			...this.byIds(selector.ids, unknown),
			...this.byUdids(selector.udids, unknown),
			...(selector.mine
				? store
						.listLeasesByOwner(ownerResolver.resolve(this.host))
						.filter((l) => selector.label === undefined || l.label === selector.label)
				: []),
			...(selector.session !== undefined ? store.listLeasesByOwner(ownerResolver.sessionOwner(selector.session)) : []),
		];
		return { leases: [...new Map(leases.map((l) => [l.id, l])).values()], unknown };
	}

	private byIds(ids: string[], unknown: string[]): Lease[] {
		const store = this.host.store();
		return ids.flatMap((id) => {
			const lease = store.getLease(id);
			if (!lease) unknown.push(id);
			return lease ? [lease] : [];
		});
	}

	private byUdids(udids: string[], unknown: string[]): Lease[] {
		if (udids.length === 0) return [];
		const all = this.host.store().listLeases();
		return udids.flatMap((udid) => {
			const hits = all.filter((l) => l.resource.kind === "device" && l.resource.id === udid);
			if (hits.length === 0) unknown.push(udid);
			return hits;
		});
	}
}
