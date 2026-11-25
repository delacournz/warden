import { sameOwner } from "@delacour/warden-core/types";
import { resolveOwner } from "../claim-flags";
import type { CommandContext } from "../context";

/**
 * Host side of `warden dev --host`: `__host-tunnel` runs as the session command of the laptop's `ssh -R` and
 * proves the forward works (Metro answers on the host's loopback), then holds the host's port lease for as long
 * as the ssh stays open. The lease goes when the tunnel does, however it ends.
 */

export const TUNNEL_READY_TIMEOUT_MS = 20_000;
export const TUNNEL_BEAT_MS = 30_000;
const PROBE_EVERY_MS = 250;

export type TunnelServeDeps = {
	/** whether Metro answers on 127.0.0.1:`port` */
	probe?: (port: number) => Promise<boolean>;
	/** resolves when the laptop's ssh goes away (stdin closed) */
	closed?: Promise<void>;
	sleep?: (ms: number) => Promise<void>;
	readyTimeoutMs?: number;
	beatMs?: number;
};

/** Metro's own liveness answer: `GET /status` → `packager-status:running`. */
export async function metroAnswers(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1_000) });
		return (await res.text()).includes("packager-status:running");
	} catch {
		return false;
	}
}

async function stdinClosed(): Promise<void> {
	const reader = Bun.stdin.stream().getReader();
	for (;;) {
		const { done } = await reader.read();
		if (done) return;
	}
}

function fail(ctx: CommandContext, message: string): number {
	ctx.out(JSON.stringify({ ok: false, command: "__host-tunnel", error: { message } }));
	return 1;
}

/** Which check refuses `leaseId` for this caller and port, if any. */
function refusal(ctx: CommandContext, leaseId: string, port: number): string | undefined {
	const lease = ctx.store().getLease(leaseId);
	if (lease === undefined) return `no lease ${leaseId} on this host`;
	if (!sameOwner(lease.owner, resolveOwner(ctx))) return `${leaseId} is not your port lease`;
	if (lease.resource.kind !== "port" || lease.resource.port !== port) return `${leaseId} does not hold port ${port}`;
	return undefined;
}

async function waitReady(
	ctx: CommandContext,
	port: number,
	probe: (port: number) => Promise<boolean>,
	sleep: (ms: number) => Promise<void>,
	timeoutMs: number
): Promise<boolean> {
	const deadline = ctx.now() + timeoutMs;
	for (;;) {
		if (await probe(port)) return true;
		if (ctx.now() >= deadline) return false;
		await sleep(PROBE_EVERY_MS);
	}
}

/** `__host-tunnel --port <p> --lease <id>`: 0 once the laptop hangs up after a ready tunnel, 1 otherwise. */
export async function serveTunnel(
	ctx: CommandContext,
	target: { port: number; leaseId: string },
	deps: TunnelServeDeps = {}
): Promise<number> {
	const { port, leaseId } = target;
	const why = refusal(ctx, leaseId, port);
	if (why !== undefined) return fail(ctx, why);
	const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
	const store = ctx.store();
	try {
		const ready = await waitReady(
			ctx,
			port,
			deps.probe ?? metroAnswers,
			sleep,
			deps.readyTimeoutMs ?? TUNNEL_READY_TIMEOUT_MS
		);
		if (!ready) return fail(ctx, `no Metro on 127.0.0.1:${port} through the forward (is it running on the laptop?)`);
		ctx.out(JSON.stringify({ ready: true, port }));
		let open = true;
		const closed = (deps.closed ?? stdinClosed()).then(() => {
			open = false;
		});
		while (open) {
			store.heartbeat([leaseId], ctx.now());
			await Promise.race([sleep(deps.beatMs ?? TUNNEL_BEAT_MS), closed]);
		}
		return 0;
	} finally {
		store.deleteLeases([leaseId]);
	}
}
