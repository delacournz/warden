import { createServer } from "node:net";
import { portSpecParser } from "@delacour/warden-config/ports-spec";
import { liveness, type PidAlive } from "@delacour/warden-store/liveness";
import type { Store } from "@delacour/warden-store/store";
import { storeLocator } from "@delacour/warden-store/store";
import type { Lease, Owner, PortResource } from "@delacour/warden-store/types";
import { type WardenError, wardenErrors } from "@delacour/warden-types/error";
import type { AsyncResult, Result } from "@delacour/warden-types/result";
import { resultFactory } from "@delacour/warden-types/result";

/** Extra free candidates probed beyond `count`, so a lost race still leaves spares. */
const PROBE_SLACK = 4;
const CLAIM_ATTEMPTS = 5;

export type ProbeOutcome = "free" | "busy" | "unsupported";

/** Hosts probed by default: loopback v4, wildcard v4, wildcard v6 (Metro etc. bind `::`). */
const DEFAULT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

/** Real-socket bind probe. */
export class PortProbe {
	/**
	 * A failed probe bind → outcome. In use / forbidden is busy anywhere; a missing address or family is
	 * unsupported; any other error on the IPv6 wildcard is unsupported too (Bun reports a code-less
	 * "Failed to listen at ::" on hosts without IPv6), while on an IPv4 host it stays busy.
	 */
	classifyBindError(error: { code?: string }, host: string): Exclude<ProbeOutcome, "free"> {
		if (error.code === "EADDRINUSE" || error.code === "EACCES") return "busy";
		if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT") return "unsupported";
		return host === "::" ? "unsupported" : "busy";
	}

	/**
	 * Bind probe: listen on `port` and close immediately. With `host`, probes only that address;
	 * otherwise the port must bind on 127.0.0.1, 0.0.0.0 and `::` (hosts without IPv6 are skipped).
	 */
	async isFree(port: number, host?: string): Promise<boolean> {
		const hosts = host === undefined ? DEFAULT_PROBE_HOSTS : [host];
		for (const h of hosts) {
			const outcome = await this.probe(port, h);
			if (outcome === "busy") return false;
			if (outcome === "unsupported" && host !== undefined) return false;
		}
		return true;
	}

	private probe(port: number, host: string): Promise<ProbeOutcome> {
		return new Promise((done) => {
			const server = createServer();
			server.unref();
			server.once("error", (error: NodeJS.ErrnoException) => done(this.classifyBindError(error, host)));
			server.listen({ port, host, exclusive: true }, () => server.close(() => done("free")));
		});
	}
}

export const portProbe = new PortProbe();

export type ClaimPortsRequest = {
	owner: Owner;
	from: number;
	span: number;
	/** ports wanted (default 1) */
	count?: number;
	/** candidate stride inside the range (default 1; 2 for emulator console ports) */
	step?: number;
	ttlMs: number;
	label?: string;
	pid?: number;
};

export type ClaimPortsDeps = {
	now: () => number;
	pidAlive: PidAlive;
	isPortFree: (port: number) => Promise<boolean>;
};

/** Which port leases to release. */
export type PortReleaseSelector =
	| { by: "port"; ports: readonly number[] }
	| { by: "lease"; ids: readonly string[] }
	| { by: "owner"; owner: Owner };

export type PortReleaseResult = {
	released: Lease[];
	/** matched but held by someone other than `onlyOwner` — left in place */
	denied: Lease[];
	/** ports / lease ids with no matching port lease */
	missing: string[];
};

type TxnOutcome = { kind: "leased"; leases: Lease[] } | { kind: "short" };

type ClaimPlan = { all: number[]; count: number; exhausted: string };

/** Leases, releases and lists the machine's dev-server ports through the store. */
export class PortAllocator {
	constructor(private readonly store: Store) {}

	/**
	 * Lease `count` ports from `[from, from + span)` (stride `step`). Bind probes run outside the
	 * transaction (async); then, under `BEGIN IMMEDIATE`: reclaim stale leases, pick the first probed-free
	 * ports with no live lease, insert them. Retries when another process wins the race.
	 */
	async claim(req: ClaimPortsRequest, deps: ClaimPortsDeps): AsyncResult<Lease[], WardenError> {
		const plan = this.planClaim(req);
		if (!plan.success) return plan;
		for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
			const probed = await this.probeCandidates(plan.data, deps);
			if (probed.length < plan.data.count) break;
			try {
				const outcome = this.leaseProbed(req, probed, plan.data.count, deps);
				if (outcome.kind === "leased") return resultFactory.ok(outcome.leases);
			} catch (error) {
				if (!this.isUniqueViolation(error))
					return wardenErrors.err("failed", error instanceof Error ? error.message : String(error));
			}
		}
		return wardenErrors.err("capacity_exhausted", plan.data.exhausted, { retryable: true });
	}

	/**
	 * Release port leases by port number, lease id, or owner. With `onlyOwner`, leases held by anyone
	 * else are reported in `denied` and kept. Non-port lease ids count as `missing` (never deleted here).
	 */
	release(selector: PortReleaseSelector, opts: { onlyOwner?: Owner } = {}): PortReleaseResult {
		const { store } = this;
		return store.transaction(() => {
			const { matched, missing } = this.matchSelector(this.list(), selector);
			const allowedKey = opts.onlyOwner ? storeLocator.ownerKey(opts.onlyOwner) : undefined;
			const released = matched.filter((l) => allowedKey === undefined || storeLocator.ownerKey(l.owner) === allowedKey);
			const denied = matched.filter((l) => !released.includes(l));
			store.deleteLeases(released.map((l) => l.id));
			return { released, denied, missing };
		});
	}

	/** All port leases (live or stale), ordered by port. */
	list(): Lease[] {
		return this.store
			.listLeases()
			.filter((l) => l.resource.kind === "port")
			.sort((a, b) => (this.leasedPort(a) ?? 0) - (this.leasedPort(b) ?? 0));
	}

	private leasedPort(lease: Lease): number | undefined {
		return lease.resource.kind === "port" ? lease.resource.port : undefined;
	}

	private candidates(from: number, span: number, step: number): number[] {
		const out: number[] = [];
		for (let p = from; p < from + span; p += step) out.push(p);
		return out;
	}

	private isUniqueViolation(error: unknown): boolean {
		return error instanceof Error && /UNIQUE constraint/i.test(error.message);
	}

	private planClaim(req: ClaimPortsRequest): Result<ClaimPlan, WardenError> {
		const range = wardenErrors.coded(portSpecParser.check(req.from, req.span), "usage");
		if (!range.success) return range;
		const count = req.count ?? 1;
		const step = req.step ?? 1;
		if (!Number.isInteger(count) || count < 1) return wardenErrors.err("usage", `invalid count ${count} (must be ≥ 1)`);
		if (!Number.isInteger(step) || step < 1) return wardenErrors.err("usage", `invalid step ${step} (must be ≥ 1)`);
		return resultFactory.ok({
			all: this.candidates(req.from, req.span, step),
			count,
			exhausted: `no free port in ${req.from}–${req.from + req.span - 1}`,
		});
	}

	/** Probe (outside any txn) candidates with no live lease; stop after `count + PROBE_SLACK` hits. */
	private async probeCandidates(plan: ClaimPlan, deps: ClaimPortsDeps): Promise<number[]> {
		const now = deps.now();
		const leased = new Set(
			this.store
				.listLeases()
				.filter((l) => liveness.isLeaseAlive(l, now, deps.pidAlive))
				.map((l) => this.leasedPort(l))
		);
		const free: number[] = [];
		for (const port of plan.all) {
			if (free.length >= plan.count + PROBE_SLACK) break;
			if (leased.has(port)) continue;
			if (await deps.isPortFree(port)) free.push(port);
		}
		return free;
	}

	/** Under `BEGIN IMMEDIATE`: reclaim stale, drop ports leased meanwhile, insert the first `count`. */
	private leaseProbed(
		req: ClaimPortsRequest,
		probed: readonly number[],
		count: number,
		deps: ClaimPortsDeps
	): TxnOutcome {
		const { store } = this;
		return store.transaction((): TxnOutcome => {
			const at = deps.now();
			store.reclaimStale(at, deps.pidAlive);
			const taken = new Set(store.listLeases().map((l) => this.leasedPort(l)));
			const pick = probed.filter((p) => !taken.has(p)).slice(0, count);
			if (pick.length < count) return { kind: "short" };
			const extra = {
				...(req.label !== undefined ? { label: req.label } : {}),
				...(req.pid !== undefined ? { pid: req.pid } : {}),
			};
			const leases = pick.map((port) => {
				const resource: PortResource = { kind: "port", port };
				return store.insertLease({ resource, owner: req.owner, ttlMs: req.ttlMs, ...extra }, at);
			});
			return { kind: "leased", leases };
		});
	}

	private matchSelector(
		portLeases: readonly Lease[],
		selector: PortReleaseSelector
	): { matched: Lease[]; missing: string[] } {
		const byKey = (keys: readonly string[], keyOf: (l: Lease) => string) => {
			const matched: Lease[] = [];
			const missing: string[] = [];
			for (const key of keys) {
				const lease = portLeases.find((l) => keyOf(l) === key);
				if (lease) matched.push(lease);
				else missing.push(key);
			}
			return { matched, missing };
		};
		switch (selector.by) {
			case "port":
				return byKey(selector.ports.map(String), (l) => String(this.leasedPort(l)));
			case "lease":
				return byKey(selector.ids, (l) => l.id);
			case "owner": {
				const key = storeLocator.ownerKey(selector.owner);
				return { matched: portLeases.filter((l) => storeLocator.ownerKey(l.owner) === key), missing: [] };
			}
		}
	}
}
