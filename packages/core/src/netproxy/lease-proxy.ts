import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { recordCondition } from "../conditions/conditions";
import type { NetworkCondition } from "../conditions/conditions.types";
import { type PidAlive, processAlive } from "../liveness";
import { claimPorts, isPortFree, releasePorts } from "../ports";
import type { Store } from "../store";
import type { Lease } from "../types";
import { getProxyStatus, type ProxyHandle, setProxyConditions, stopProxy } from "./control";
import { handlePath, readHandleFile, removeHandleFile } from "./handle-file";
import type { NetproxyMainArgs } from "./netproxy.main";
import type { ProxyConditions } from "./shaping";

/** Where lease proxies listen unless told otherwise. */
export const DEFAULT_PROXY_PORTS = { from: 19_080, span: 200 } as const;
const READY_TIMEOUT_MS = 5000;
const POLL_MS = 25;

export type LeaseProxyDeps = {
	store: Store;
	env: Record<string, string | undefined>;
	now: () => number;
	pidAlive?: PidAlive;
	isPortFree?: (port: number) => Promise<boolean>;
	/** argv prefix that runs `netproxy.main.ts` (the JSON argument is appended). Default: `bun` + the script next to this file; a compiled `warden` passes its own hidden subcommand. */
	command?: readonly string[];
	/** start argv detached and return its pid; default: `child_process.spawn` detached with no stdio */
	spawn?: (argv: readonly string[], env: Record<string, string | undefined>) => number | undefined;
	kill?: (pid: number) => void;
	ports?: { from: number; span: number };
	readyTimeoutMs?: number;
};

/** The proxy a lease owns, and the port lease holding its port. */
export type LeaseProxy = { handle: ProxyHandle; portLeaseId: string; reused: boolean };

export type EnsureProxyInput = {
	/** what `recordCondition` stores for the `network` area */
	condition: NetworkCondition;
	/** shaping to apply now (already translated from `condition`) */
	conditions: ProxyConditions;
	/** seeds loss/jitter for a reproducible run */
	seed?: number;
};

function defaultCommand(): string[] {
	const bun = basename(process.execPath).startsWith("bun") ? process.execPath : (Bun.which("bun") ?? "bun");
	return [bun, join(import.meta.dir, "netproxy.main.ts")];
}

function spawnDetached(argv: readonly string[], env: Record<string, string | undefined>): number | undefined {
	const [bin, ...args] = argv;
	if (!bin) return undefined;
	const child = spawn(bin, args, { detached: true, stdio: "ignore", env: { ...process.env, ...env } });
	child.on("error", () => {});
	child.unref();
	return child.pid;
}

async function waitForHandle(path: string, pid: number, timeoutMs: number, alive: PidAlive) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const file = readHandleFile(path);
		if (file) {
			const status = await getProxyStatus(file);
			if (status.success) return file;
		}
		if (!alive(pid)) return undefined;
		await Bun.sleep(POLL_MS);
	}
	return undefined;
}

/** A proxy that is recorded for the lease and still answers its control channel. */
async function liveProxy(path: string, alive: PidAlive): Promise<ProxyHandle | undefined> {
	const file = readHandleFile(path);
	if (!file || !alive(file.pid)) return undefined;
	return (await getProxyStatus(file)).success ? file : undefined;
}

/**
 * Make sure `lease` has a shaping proxy and apply `input.conditions` to it. Reuses a live one
 * (reconfigured over its control channel, no restart); otherwise claims a port from the allocator,
 * spawns a detached `netproxy.main.ts`, waits until it answers, and records the `network` condition
 * with the proxy pid as an `OwnedProcess` so release / gc undo kills it. The port lease's pid is
 * the proxy's, so a dead proxy frees its port. Binds 127.0.0.1 only.
 */
export async function ensureLeaseProxy(
	deps: LeaseProxyDeps,
	lease: Pick<Lease, "id" | "owner" | "ttlMs">,
	input: EnsureProxyInput
): AsyncResult<LeaseProxy> {
	const alive = deps.pidAlive ?? processAlive;
	const path = handlePath(lease.id, deps.env);
	const record = (handle: ProxyHandle) =>
		recordCondition(deps.store, lease.id, "network", input.condition, deps.now(), [{ kind: "pid", pid: handle.pid }]);

	const existing = await liveProxy(path, alive);
	if (existing) {
		const applied = await setProxyConditions(existing, input.conditions);
		if (!applied.success) return applied;
		const recorded = record(existing);
		if (!recorded.success) return recorded;
		return ok({ handle: existing, portLeaseId: readHandleFile(path)?.portLeaseId ?? "", reused: true });
	}
	removeHandleFile(path);
	const started = await startFresh(deps, lease, input, path, alive);
	if (!started.success) return started;
	const recorded = record(started.data.handle);
	if (!recorded.success) {
		await releaseLeaseProxy(deps, lease.id);
		return recorded;
	}
	return started;
}

/** Claim a port, spawn the detached proxy and wait until it answers; undoes itself on failure. */
async function startFresh(
	deps: LeaseProxyDeps,
	lease: Pick<Lease, "id" | "owner" | "ttlMs">,
	input: EnsureProxyInput,
	path: string,
	alive: PidAlive
): AsyncResult<LeaseProxy> {
	const range = deps.ports ?? DEFAULT_PROXY_PORTS;
	const claimed = await claimPorts(
		deps.store,
		{ owner: lease.owner, from: range.from, span: range.span, ttlMs: lease.ttlMs, label: `netproxy:${lease.id}` },
		{ now: deps.now, pidAlive: alive, isPortFree: deps.isPortFree ?? ((p) => isPortFree(p)) }
	);
	if (!claimed.success) return err(`netproxy: ${claimed.error}`);
	const portLease = claimed.data[0];
	if (portLease?.resource.kind !== "port") return err("netproxy: no port leased");

	const args: NetproxyMainArgs = {
		leaseId: lease.id,
		handleFile: path,
		port: portLease.resource.port,
		portLeaseId: portLease.id,
		conditions: input.conditions as NetproxyMainArgs["conditions"],
		...(input.seed !== undefined ? { seed: input.seed } : {}),
	};
	const argv = [...(deps.command ?? defaultCommand()), JSON.stringify(args)];
	const pid = (deps.spawn ?? spawnDetached)(argv, deps.env);
	const fail = (message: string) => {
		if (pid !== undefined) killQuietly(deps.kill, pid);
		removeHandleFile(path);
		releasePorts(deps.store, { by: "lease", ids: [portLease.id] });
		return err(`netproxy: ${message}`);
	};
	if (pid === undefined) return fail("could not start the proxy process");
	deps.store.setLeasePid(portLease.id, pid);

	const handle = await waitForHandle(path, pid, deps.readyTimeoutMs ?? READY_TIMEOUT_MS, alive);
	if (!handle) return fail(`proxy did not become ready (pid ${pid}); start it by hand: ${argv.join(" ")}`);
	return ok({ handle, portLeaseId: portLease.id, reused: false });
}

function killQuietly(kill: ((pid: number) => void) | undefined, pid: number): void {
	try {
		(kill ?? ((p: number) => process.kill(p, "SIGTERM")))(pid);
	} catch {
		// already gone
	}
}

/** Stop a lease's proxy (control channel, then SIGTERM) and free its port; true when one was recorded. */
export async function releaseLeaseProxy(
	deps: Pick<LeaseProxyDeps, "store" | "env" | "kill" | "pidAlive">,
	leaseId: string
): Promise<boolean> {
	const path = handlePath(leaseId, deps.env);
	const file = readHandleFile(path);
	if (!file) return false;
	const stopped = await stopProxy(file);
	if (!stopped.success && (deps.pidAlive ?? processAlive)(file.pid)) killQuietly(deps.kill, file.pid);
	removeHandleFile(path);
	if (file.portLeaseId) releasePorts(deps.store, { by: "lease", ids: [file.portLeaseId] });
	return true;
}
