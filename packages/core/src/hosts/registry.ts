import type { Store } from "../store";
import type { HostOwner } from "../types";

/**
 * The two sides of `warden host`. On a laptop: `hosts`, the Macs it drives (how to reach each over ssh). On a host:
 * `host_grants`, the laptop keys allowed in through `__host-serve` and the owner each one maps to.
 */

/** `user@hostname[:port]`, split. */
export type SshTarget = { user?: string; hostname: string; port?: number };

/** A Mac this laptop drives. `identity` is the key `ssh` uses; `hostKey` the pinned `known_hosts` key, once seen. */
export type HostRecord = {
	name: string;
	ssh: SshTarget;
	identity?: string;
	proxyCommand?: string;
	jump?: string;
	/** `ssh-ed25519 AAAA…` of the host, pinned at `host add` (trust on first use) or given with `--host-key` */
	hostKey?: string;
	/** the warden version the host answered with at its last `host add` / `host doctor` / `host setup` */
	version?: string;
	/** the warden binary on the host (absolute, written by `host setup`); unset = `warden` on the login PATH */
	wardenPath?: string;
	/** a hosted Mac's session end (epoch ms): leases on it are capped here and end `LEASE_LOST` `host_expired` */
	expiresAt?: number;
	addedAt: number;
};

/** A laptop key a host lets in. The forced command names the fingerprint; the owner is read from here. */
export type HostGrant = {
	fingerprint: string;
	machineId: string;
	user: string;
	publicKey: string;
	addedAt: number;
};

/** The env var `__host-serve` hands the owner to the command it runs in. */
export const HOST_OWNER_ENV = "WARDEN_HOST_OWNER";

const ID = /^[A-Za-z0-9._:@+-]{1,128}$/;

/** `{"machineId","user"}` from `WARDEN_HOST_OWNER`, or undefined when absent or malformed. */
export function parseHostOwner(raw: string | undefined): HostOwner | undefined {
	if (raw === undefined || raw === "") return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const machineId: unknown = Reflect.get(value, "machineId");
	const user: unknown = Reflect.get(value, "user");
	if (typeof machineId !== "string" || typeof user !== "string") return undefined;
	if (!ID.test(machineId) || !ID.test(user)) return undefined;
	return { kind: "host", machineId, user };
}

type HostRow = { name: string; json: string; added_at: number };

function toHost(row: HostRow): HostRecord {
	const parsed = JSON.parse(row.json) as Omit<HostRecord, "name" | "addedAt">;
	return { name: row.name, ...parsed, addedAt: row.added_at };
}

/** Add or replace a host by name. */
export function putHost(store: Store, host: HostRecord): void {
	const { name, addedAt, ...rest } = host;
	store.db
		.query("INSERT OR REPLACE INTO hosts (name, json, added_at) VALUES (?, ?, ?)")
		.run(name, JSON.stringify(rest), addedAt);
}

export function getHost(store: Store, name: string): HostRecord | undefined {
	const row = store.db.query<HostRow, [string]>("SELECT * FROM hosts WHERE name = ?").get(name);
	return row ? toHost(row) : undefined;
}

export function listHosts(store: Store): HostRecord[] {
	return store.db.query<HostRow, []>("SELECT * FROM hosts ORDER BY name").all().map(toHost);
}

export function deleteHost(store: Store, name: string): boolean {
	return store.db.query("DELETE FROM hosts WHERE name = ?").run(name).changes > 0;
}

type GrantRow = { fingerprint: string; machine_id: string; user: string; public_key: string; added_at: number };

function toGrant(row: GrantRow): HostGrant {
	return {
		fingerprint: row.fingerprint,
		machineId: row.machine_id,
		user: row.user,
		publicKey: row.public_key,
		addedAt: row.added_at,
	};
}

export function putGrant(store: Store, grant: HostGrant): void {
	store.db
		.query(
			"INSERT OR REPLACE INTO host_grants (fingerprint, machine_id, user, public_key, added_at) VALUES (?, ?, ?, ?, ?)"
		)
		.run(grant.fingerprint, grant.machineId, grant.user, grant.publicKey, grant.addedAt);
}

export function getGrant(store: Store, fingerprint: string): HostGrant | undefined {
	const row = store.db.query<GrantRow, [string]>("SELECT * FROM host_grants WHERE fingerprint = ?").get(fingerprint);
	return row ? toGrant(row) : undefined;
}

export function listGrants(store: Store): HostGrant[] {
	return store.db.query<GrantRow, []>("SELECT * FROM host_grants ORDER BY added_at, fingerprint").all().map(toGrant);
}

export function deleteGrant(store: Store, fingerprint: string): boolean {
	return store.db.query("DELETE FROM host_grants WHERE fingerprint = ?").run(fingerprint).changes > 0;
}
