import type { HostRecord } from "@delacour/warden-core/hosts/registry";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { RelayHost } from "../remote/api.types";

/**
 * `warden host add <name> --cloud`: a host that keeps an uplink to warden-api (`warden host uplink` there), reached
 * through the relay with this laptop's `warden login` session instead of ssh. Same allowlist and leases either way.
 */

/** `--host-id`, else the host warden-api calls `name`, else the only one. */
export function pickRelayHost(
	hosts: readonly RelayHost[],
	name: string,
	hostId: string | undefined
): Result<RelayHost> {
	const known = hosts.map((h) => `${h.id} (${h.name})`).join(", ");
	if (hostId !== undefined) {
		const byId = hosts.find((h) => h.id === hostId);
		return byId ? ok(byId) : err(`--host-id ${hostId}: not one of this account's hosts: ${known || "none"}`);
	}
	const byName = hosts.filter((h) => h.name === name);
	if (byName.length === 1 && byName[0]) return ok(byName[0]);
	if (hosts.length === 1 && hosts[0]) return ok(hosts[0]);
	if (hosts.length === 0) {
		return err("this account has no relayed hosts yet: run warden host uplink on the Mac (or start a hosted one)");
	}
	return err(`which host? pick one with --host-id: ${known}`);
}

export type RelayPin = { apiUrl: string; account?: string; organization?: string };

export function cloudRecord(name: string, host: RelayHost, pin: RelayPin, now: number): HostRecord {
	return {
		name,
		ssh: { hostname: "relay" },
		relay: {
			apiUrl: pin.apiUrl,
			hostId: host.id,
			...(pin.account !== undefined ? { account: pin.account } : {}),
			...(pin.organization !== undefined ? { organization: pin.organization } : {}),
		},
		...(host.expiresAt !== undefined ? { expiresAt: host.expiresAt } : {}),
		addedAt: now,
	};
}
