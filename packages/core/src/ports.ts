import { createServer } from "node:net";
import type { AsyncResult, Result } from "@warden/types/result";
import { err, ok } from "@warden/types/result";
import { isLeaseAlive, type PidAlive } from "./liveness";
import type { Store } from "./store";
import { ownerKey } from "./store";
import type { Lease, Owner, PortResource } from "./types";

/** Span used when a spec has no `:span` (mirrors salient's `pickPort` 20-port scan). */
export const DEFAULT_PORT_SPAN = 20;
const MAX_PORT = 65_535;
/** Extra free candidates probed beyond `count`, so a lost race still leaves spares. */
const PROBE_SLACK = 4;
const CLAIM_ATTEMPTS = 5;

export type PortRange = { from: number; span: number };

function checkRange(from: number, span: number): Result<PortRange> {
	if (!Number.isInteger(from) || from < 1 || from > MAX_PORT) return err(`invalid port ${from} (1–${MAX_PORT})`);
	if (!Number.isInteger(span) || span < 1) return err(`invalid span ${span} (must be ≥ 1)`);
	if (from + span - 1 > MAX_PORT) return err(`port range ${from}–${from + span - 1} exceeds ${MAX_PORT}`);
	return ok({ from, span });
}

/** `8091:20` → `{ from: 8091, span: 20 }`; bare `8091` → span `DEFAULT_PORT_SPAN`. */
export function parsePortSpec(spec: string): Result<PortRange> {
	const match = /^(\d+)(?::(\d+))?$/.exec(spec.trim());
	if (!match?.[1]) return err(`invalid port spec "${spec}" (use <from>[:<span>], e.g. 8091:20)`);
	return checkRange(Number(match[1]), match[2] === undefined ? DEFAULT_PORT_SPAN : Number(match[2]));
}

type ProbeOutcome = "free" | "busy" | "unsupported";

function probe(port: number, host: string): Promise<ProbeOutcome> {
	return new Promise((done) => {
		const server = createServer();
		server.unref();
		server.once("error", (error: NodeJS.ErrnoException) => {
			const unsupported = error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT";
			done(unsupported ? "unsupported" : "busy");
		});
		server.listen({ port, host, exclusive: true }, () => server.close(() => done("free")));
	});
}

/** Hosts probed by default: loopback v4, wildcard v4, wildcard v6 (Metro etc. bind `::`). */
const DEFAULT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

/**
 * Bind probe: listen on `port` and close immediately. With `host`, probes only that address;
 * otherwise the port must bind on 127.0.0.1, 0.0.0.0 and `::` (hosts without IPv6 are skipped).
 */
export async function isPortFree(port: number, host?: string): Promise<boolean> {
	const hosts = host === undefined ? DEFAULT_PROBE_HOSTS : [host];
	for (const h of hosts) {
		const outcome = await probe(port, h);
		if (outcome === "busy") return false;
		if (outcome === "unsupported" && host !== undefined) return false;
	}
	return true;
}

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

function leasedPort(lease: Lease): number | undefined {
	return lease.resource.kind === "port" ? lease.resource.port : undefined;
}

function candidates(from: number, span: number, step: number): number[] {
	const out: number[] = [];
	for (let p = from; p < from + span; p += step) out.push(p);
	return out;
}

function isUniqueViolation(error: unknown): boolean {
	return error instanceof Error && /UNIQUE constraint/i.test(error.message);
}

type TxnOutcome = { kind: "leased"; leases: Lease[] } | { kind: "short" };

type ClaimPlan = { all: number[]; count: number; exhausted: string };

function planClaim(req: ClaimPortsRequest): Result<ClaimPlan> {
	const range = checkRange(req.from, req.span);
	if (!range.success) return range;
	const count = req.count ?? 1;
	const step = req.step ?? 1;
	if (!Number.isInteger(count) || count < 1) return err(`invalid count ${count} (must be ≥ 1)`);
	if (!Number.isInteger(step) || step < 1) return err(`invalid step ${step} (must be ≥ 1)`);
	return ok({
		all: candidates(req.from, req.span, step),
		count,
		exhausted: `no free port in ${req.from}–${req.from + req.span - 1}`,
	});
}

/** Probe (outside any txn) candidates with no live lease; stop after `count + PROBE_SLACK` hits. */
async function probeCandidates(store: Store, plan: ClaimPlan, deps: ClaimPortsDeps): Promise<number[]> {
	const now = deps.now();
	const leased = new Set(
		store
			.listLeases()
			.filter((l) => isLeaseAlive(l, now, deps.pidAlive))
			.map(leasedPort)
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
function leaseProbed(
	store: Store,
	req: ClaimPortsRequest,
	probed: readonly number[],
	count: number,
	deps: ClaimPortsDeps
): TxnOutcome {
	return store.transaction((): TxnOutcome => {
		const at = deps.now();
		store.reclaimStale(at, deps.pidAlive);
		const taken = new Set(store.listLeases().map(leasedPort));
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

/**
 * Lease `count` ports from `[from, from + span)` (stride `step`). Bind probes run outside the
 * transaction (async); then, under `BEGIN IMMEDIATE`: reclaim stale leases, pick the first probed-free
 * ports with no live lease, insert them. Retries when another process wins the race.
 */
export async function claimPorts(store: Store, req: ClaimPortsRequest, deps: ClaimPortsDeps): AsyncResult<Lease[]> {
	const plan = planClaim(req);
	if (!plan.success) return plan;
	for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
		const probed = await probeCandidates(store, plan.data, deps);
		if (probed.length < plan.data.count) break;
		try {
			const outcome = leaseProbed(store, req, probed, plan.data.count, deps);
			if (outcome.kind === "leased") return ok(outcome.leases);
		} catch (error) {
			if (!isUniqueViolation(error)) return err(error);
		}
	}
	return err(plan.data.exhausted);
}

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

/**
 * Release port leases by port number, lease id, or owner. With `onlyOwner`, leases held by anyone
 * else are reported in `denied` and kept. Non-port lease ids count as `missing` (never deleted here).
 */
export function releasePorts(
	store: Store,
	selector: PortReleaseSelector,
	opts: { onlyOwner?: Owner } = {}
): PortReleaseResult {
	return store.transaction(() => {
		const { matched, missing } = matchSelector(listPortLeases(store), selector);
		const allowedKey = opts.onlyOwner ? ownerKey(opts.onlyOwner) : undefined;
		const released = matched.filter((l) => allowedKey === undefined || ownerKey(l.owner) === allowedKey);
		const denied = matched.filter((l) => !released.includes(l));
		store.deleteLeases(released.map((l) => l.id));
		return { released, denied, missing };
	});
}

function matchSelector(
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
			return byKey(selector.ports.map(String), (l) => String(leasedPort(l)));
		case "lease":
			return byKey(selector.ids, (l) => l.id);
		case "owner": {
			const key = ownerKey(selector.owner);
			return { matched: portLeases.filter((l) => ownerKey(l.owner) === key), missing: [] };
		}
	}
}

/** All port leases (live or stale), ordered by port. */
export function listPortLeases(store: Store): Lease[] {
	return store
		.listLeases()
		.filter((l) => l.resource.kind === "port")
		.sort((a, b) => (leasedPort(a) ?? 0) - (leasedPort(b) ?? 0));
}
