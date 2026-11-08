import type { NetworkCondition } from "@delacour/warden-core/conditions/conditions.types";
import type { ConditionsUpdate } from "@delacour/warden-core/netproxy/control";
import type { ProxyConditions } from "@delacour/warden-core/netproxy/shaping";
import { err, ok } from "@delacour/warden-types/result";
import type { NetworkProxyPort, ProxyAddress } from "./network-proxy";

/** A `NetworkProxyPort` that records every call and never spawns a process. */
export type FakeProxy = NetworkProxyPort & {
	calls: (
		| { op: "ensure"; condition: NetworkCondition; conditions: ProxyConditions }
		| { op: "update"; update: ConditionsUpdate }
		| { op: "stop" }
	)[];
	address: ProxyAddress | undefined;
	/** next `ensure` fails with this */
	failEnsure?: string;
};

export function fakeProxy(port = 19_080, live = false): FakeProxy {
	const proxy: FakeProxy = {
		calls: [],
		address: live ? { host: "127.0.0.1", port } : undefined,
		async current() {
			return proxy.address;
		},
		async ensure(condition, conditions) {
			proxy.calls.push({ op: "ensure", condition, conditions });
			if (proxy.failEnsure) return err(proxy.failEnsure);
			proxy.address = { host: "127.0.0.1", port };
			return ok(proxy.address);
		},
		async update(update) {
			proxy.calls.push({ op: "update", update });
			return proxy.address ? ok(undefined) : err("no live network proxy for this lease");
		},
		async stop() {
			proxy.calls.push({ op: "stop" });
			proxy.address = undefined;
		},
	};
	return proxy;
}
