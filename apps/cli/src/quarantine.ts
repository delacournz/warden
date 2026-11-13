import { PENDING_PREFIX } from "@delacour/warden-core/claim";
import { wardenNameProfile } from "@delacour/warden-core/inventory";
import type { Store } from "@delacour/warden-core/store";
import type { Lease } from "@delacour/warden-core/types";

/** What `quarantineLeases` did: the device ids it quarantined, and the devices it left alone (not warden's). */
export type Quarantined = { quarantined: string[]; foreign: Array<{ id: string; name: string }> };

/**
 * Quarantine the devices behind `leases` so no claim hands them out again (`warden release --bad`; cleared by
 * `warden sim unquarantine`). Only warden devices (a store record or a `warden-<profile>-N` name): a foreign one is
 * left alone and listed in `foreign`. Port leases and pending placeholders are skipped.
 */
export function quarantineLeases(
	store: Pick<Store, "listDevices" | "quarantineDevice">,
	leases: readonly Lease[],
	reason: string | undefined,
	now: number
): Quarantined {
	const quarantined: string[] = [];
	const foreign: Quarantined["foreign"] = [];
	const records = store.listDevices();
	for (const l of leases) {
		if (l.resource.kind !== "device" || l.resource.id.startsWith(PENDING_PREFIX)) continue;
		const { platform, id, name } = l.resource;
		const record = records.find((r) => r.platform === platform && r.id === id);
		const profile = record?.profile ?? wardenNameProfile(name);
		if (!record && profile === undefined) {
			foreign.push({ id, name });
			continue;
		}
		store.quarantineDevice({ platform, id, name, ...(profile !== undefined ? { profile } : {}) }, reason, now);
		quarantined.push(id);
	}
	return { quarantined, foreign };
}
