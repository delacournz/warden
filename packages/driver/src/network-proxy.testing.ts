import type { NetworkCondition } from "@delacour/warden-config/conditions.types";
import type { ConditionsUpdate, ProxyConditions } from "@delacour/warden-config/shaping";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import type { NetworkProxyPort, ProxyAddress } from "./network-proxy";

type FakeProxyCall =
	| { op: "ensure"; condition: NetworkCondition; conditions: ProxyConditions }
	| { op: "update"; update: ConditionsUpdate }
	| { op: "stop" };

/** A `NetworkProxyPort` that records every call and never spawns a process. */
export class FakeProxy implements NetworkProxyPort {
	readonly calls: FakeProxyCall[] = [];
	address: ProxyAddress | undefined;
	/** next `ensure` fails with this */
	failEnsure?: string;

	constructor(
		private readonly port = 19_080,
		live = false
	) {
		this.address = live ? { host: "127.0.0.1", port } : undefined;
	}

	async current(): Promise<ProxyAddress | undefined> {
		return this.address;
	}

	async ensure(condition: NetworkCondition, conditions: ProxyConditions): AsyncResult<ProxyAddress> {
		this.calls.push({ op: "ensure", condition, conditions });
		if (this.failEnsure) return resultFactory.err(this.failEnsure);
		this.address = { host: "127.0.0.1", port: this.port };
		return resultFactory.ok(this.address);
	}

	async update(update: ConditionsUpdate): AsyncResult<void> {
		this.calls.push({ op: "update", update });
		return this.address ? resultFactory.ok(undefined) : resultFactory.err("no live network proxy for this lease");
	}

	async stop(): Promise<void> {
		this.calls.push({ op: "stop" });
		this.address = undefined;
	}
}
