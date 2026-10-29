import type { HostFault, NetworkCondition } from "@delacour/warden-core/conditions/conditions.types";
import type { ConditionsUpdate } from "@delacour/warden-core/netproxy/control";
import { getProxyStatus, setProxyConditions } from "@delacour/warden-core/netproxy/control";
import { handlePath, readHandleFile } from "@delacour/warden-core/netproxy/handle-file";
import { ensureLeaseProxy, type LeaseProxyDeps, releaseLeaseProxy } from "@delacour/warden-core/netproxy/lease-proxy";
import { type ProxyConditions, shapingFromCondition } from "@delacour/warden-core/netproxy/shaping";
import type { Lease } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";

/** Where a lease's shaping proxy listens (always loopback on the host). */
export type ProxyAddress = { host: string; port: number };

/**
 * What a driver needs from the lease's shaping proxy (COND-4). The drivers never touch the lease store: whoever
 * opens the driver builds this (`leaseNetworkProxy`) or passes a fake in tests.
 */
export type NetworkProxyPort = {
	/** The live proxy's address, `undefined` when this lease has none. */
	current(): Promise<ProxyAddress | undefined>;
	/** Start the proxy (or reuse the live one) with `conditions` applied; records `condition` as the lease's network condition. */
	ensure(condition: NetworkCondition, conditions: ProxyConditions): AsyncResult<ProxyAddress>;
	/** Reconfigure the live proxy without dropping connections. Fails when there is none. */
	update(update: ConditionsUpdate): AsyncResult<void>;
	/** Stop the proxy and free its port. */
	stop(): Promise<void>;
};

/** `NetworkProxyPort` for one lease over the real store and the detached `netproxy` process. */
export function leaseNetworkProxy(
	deps: LeaseProxyDeps,
	lease: Pick<Lease, "id" | "owner" | "ttlMs">
): NetworkProxyPort {
	const handle = () => readHandleFile(handlePath(lease.id, deps.env));
	const live = async () => {
		const file = handle();
		return file && (await getProxyStatus(file)).success ? file : undefined;
	};
	return {
		async current() {
			const file = await live();
			return file ? { host: file.host, port: file.port } : undefined;
		},
		async ensure(condition, conditions) {
			const started = await ensureLeaseProxy(deps, lease, { condition, conditions });
			return started.success ? ok({ host: started.data.handle.host, port: started.data.handle.port }) : started;
		},
		async update(update) {
			const file = await live();
			if (!file) return err("no live network proxy for this lease");
			const applied = await setProxyConditions(file, update);
			return applied.success ? ok(undefined) : applied;
		},
		async stop() {
			await releaseLeaseProxy(deps, lease.id);
		},
	};
}

/** The proxy parameters for `condition` plus the faults to keep. Offline is `refuse`: connections close at accept. */
export function proxyConditionsFor(condition: NetworkCondition, faults: readonly HostFault[]): ProxyConditions {
	return { params: shapingFromCondition(condition), faults };
}

/**
 * Faults the proxy cannot honour as written. An HTTPS request is a CONNECT tunnel the proxy never reads inside
 * (no MITM), so a `status` fault on a host reaches an https:// request as a reset, not a status code.
 */
export function faultNotes(faults: readonly HostFault[]): string[] {
	return faults
		.filter((f) => f.action.kind === "status")
		.map(
			(f) =>
				`status ${f.action.kind === "status" ? f.action.code : ""} for ${f.match} answers plain http:// only; https:// requests to it are reset (the proxy does not decrypt TLS)`
		);
}
