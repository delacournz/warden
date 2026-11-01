import type { HostFault, NetworkCondition } from "@delacour/warden-config/conditions.types";
import { type ConditionsUpdate, type ProxyConditions, proxyShaping } from "@delacour/warden-config/shaping";
import type { AsyncResult } from "@delacour/warden-types/result";

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

/** Shaping-proxy parameters for a driver's network ops. Use the shared {@link networkProxyShaping} singleton. */
export class NetworkProxyShaping {
	/** The proxy parameters for `condition` plus the faults to keep. Offline is `refuse`: connections close at accept. */
	conditionsFor(condition: NetworkCondition, faults: readonly HostFault[]): ProxyConditions {
		return { params: proxyShaping.fromCondition(condition), faults };
	}

	/**
	 * Faults the proxy cannot honour as written. An HTTPS request is a CONNECT tunnel the proxy never reads inside
	 * (no MITM), so a `status` fault on a host reaches an https:// request as a reset, not a status code.
	 */
	faultNotes(faults: readonly HostFault[]): string[] {
		return faults
			.filter((f) => f.action.kind === "status")
			.map(
				(f) =>
					`status ${f.action.kind === "status" ? f.action.code : ""} for ${f.match} answers plain http:// only; https:// requests to it are reset (the proxy does not decrypt TLS)`
			);
	}
}

export const networkProxyShaping = new NetworkProxyShaping();
