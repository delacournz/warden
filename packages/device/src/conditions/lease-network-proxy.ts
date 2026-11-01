import { proxyControl } from "@delacour/warden-core/netproxy/control";
import { handleFiles } from "@delacour/warden-core/netproxy/handle-file";
import { type LeaseProxyDeps, LeaseProxyService } from "@delacour/warden-core/netproxy/lease-proxy";
import type { NetworkProxyPort } from "@delacour/warden-driver/network-proxy";
import type { Store } from "@delacour/warden-store/store";
import type { Lease } from "@delacour/warden-store/types";
import { type Result, resultFactory } from "@delacour/warden-types/result";

/** `NetworkProxyPort` for one lease over the real store and the detached `netproxy` process. */
export class LeaseNetworkProxy implements NetworkProxyPort {
	constructor(
		private readonly deps: LeaseProxyDeps,
		private readonly lease: Pick<Lease, "id" | "owner" | "ttlMs">
	) {}

	async current() {
		const file = await this.live();
		return file ? { host: file.host, port: file.port } : undefined;
	}

	async ensure(
		condition: Parameters<NetworkProxyPort["ensure"]>[0],
		conditions: Parameters<NetworkProxyPort["ensure"]>[1]
	): ReturnType<NetworkProxyPort["ensure"]> {
		const started = await new LeaseProxyService(this.deps).ensure(this.lease, { condition, conditions });
		return started.success
			? resultFactory.ok({ host: started.data.handle.host, port: started.data.handle.port })
			: started;
	}

	async update(update: Parameters<NetworkProxyPort["update"]>[0]): ReturnType<NetworkProxyPort["update"]> {
		const file = await this.live();
		if (!file) return resultFactory.err("no live network proxy for this lease");
		const applied = await proxyControl.setConditions(file, update);
		return applied.success ? resultFactory.ok(undefined) : applied;
	}

	async stop() {
		await new LeaseProxyService(this.deps).release(this.lease.id);
	}

	private handle() {
		return handleFiles.read(handleFiles.path(this.lease.id, this.deps.env));
	}

	private async live() {
		const file = this.handle();
		return file && (await proxyControl.status(file)).success ? file : undefined;
	}
}

export type LazyLeaseProxyOptions = {
	leaseId: string;
	env: Record<string, string | undefined>;
	now: () => number;
	/** opens the lease store; called only when the proxy has to be started or stopped */
	openStore: () => Result<Store>;
	/** argv that runs the proxy process (`WARDEN_NETPROXY_COMMAND`); default: `bun netproxy.main.ts` from source */
	command?: readonly string[] | undefined;
	/** test seams passed through to `LeaseProxyService` (spawn, pid liveness, port range…) */
	proxyDeps?: Partial<Omit<LeaseProxyDeps, "store" | "env" | "now" | "command">>;
};

/**
 * `NetworkProxyPort` for a spec's lease that touches nothing until a network condition needs it: the store is not
 * opened (nor the lease read) before `ensure`, so a spec that never shapes the network costs no store access or
 * proxy. `current` / `update` / `stop` work from the lease's handle file and stay off the store while there is none.
 */
export class LazyLeaseNetworkProxy implements NetworkProxyPort {
	private inner: NetworkProxyPort | undefined;

	constructor(private readonly o: LazyLeaseProxyOptions) {}

	async current() {
		if (this.inner) return this.inner.current();
		const file = this.handle();
		return file && (await proxyControl.status(file)).success ? { host: file.host, port: file.port } : undefined;
	}

	async ensure(
		condition: Parameters<NetworkProxyPort["ensure"]>[0],
		conditions: Parameters<NetworkProxyPort["ensure"]>[1]
	): ReturnType<NetworkProxyPort["ensure"]> {
		const ready = this.need();
		return ready.success ? ready.data.ensure(condition, conditions) : ready;
	}

	async update(update: Parameters<NetworkProxyPort["update"]>[0]): ReturnType<NetworkProxyPort["update"]> {
		const file = this.handle();
		if (!file || !(await proxyControl.status(file)).success)
			return resultFactory.err("no live network proxy for this lease");
		const applied = await proxyControl.setConditions(file, update);
		return applied.success ? resultFactory.ok(undefined) : applied;
	}

	async stop() {
		if (!this.inner && this.handle() === undefined) return;
		const ready = this.need();
		if (ready.success) await ready.data.stop();
	}

	private handle() {
		return handleFiles.read(handleFiles.path(this.o.leaseId, this.o.env));
	}

	private need(): Result<NetworkProxyPort> {
		if (this.inner) return resultFactory.ok(this.inner);
		const store = this.o.openStore();
		if (!store.success) return store;
		const lease = store.data.getLease(this.o.leaseId);
		if (!lease)
			return resultFactory.err(`lease ${this.o.leaseId} is not in the warden store; its network cannot be shaped`);
		this.inner = new LeaseNetworkProxy(
			{
				...this.o.proxyDeps,
				store: store.data,
				env: this.o.env,
				now: this.o.now,
				...(this.o.command === undefined ? {} : { command: this.o.command }),
			},
			lease
		);
		return resultFactory.ok(this.inner);
	}
}
