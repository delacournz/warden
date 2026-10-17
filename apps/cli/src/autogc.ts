import { spawn } from "node:child_process";
import { cacheCap, cacheTotal } from "@delacour/warden-core/builds/prune";
import { DEFAULT_IDLE_MS } from "@delacour/warden-core/config.defaults";
import { type PidAlive, processAlive } from "@delacour/warden-core/liveness";
import type { CommandContext } from "./context";

/** Background `warden gc` is considered at most this often, machine-wide. */
export const AUTO_GC_INTERVAL_MS = 10 * 60_000;
/** store meta key holding when auto-gc was last considered (the throttle) */
export const AUTO_GC_META_KEY = "auto_gc_checked_at";
/** The background pass yields to the run that started it. */
const NICENESS = "10";

/** `nice -n 10` when this machine has `nice`, else nothing: the pass then runs at normal priority. */
export function niceCommand(which: (cmd: string) => string | null | undefined = Bun.which): string[] {
	return which("nice") ? ["nice", "-n", NICENESS] : [];
}

/** argv that re-runs this warden: the compiled binary, or `bun <cli.ts>` from source. */
export function selfCommand(): string[] {
	return Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main];
}

/** `WARDEN_BACKGROUND=0` turns off every detached worker (auto-gc, SessionEnd shutdown) — work then runs inline or not at all. */
export function backgroundAllowed(env: Record<string, string | undefined>): boolean {
	return env.WARDEN_BACKGROUND !== "0";
}

/** Fire-and-forget: detached, no stdio, never awaited — outlives the hook that started it. */
export function spawnDetached(cmd: string[], env: Record<string, string | undefined>): void {
	const [bin, ...args] = cmd;
	if (!bin) return;
	const child = spawn(bin, args, { detached: true, stdio: "ignore", env });
	child.on("error", () => {
		// the binary vanished or cannot run: nothing to reap now, the next interval tries again
	});
	child.unref();
}

/**
 * Kick off `nice -n 10 warden gc --quiet` when there is something for it to do: at most once per
 * `AUTO_GC_INTERVAL_MS` (the throttle is kept in the store, so every hook/claim across every
 * process shares it) it looks at the store: a lease whose owner died, or a warden device that went
 * idle since the last pass, or a build cache over its cap (one `SUM` over the builds table). Nothing there, nothing is spawned (a pass is a full warden process,
 * ~100 MB). This is what reaps sims left behind by sessions that died without a SessionEnd: their
 * leases go stale, gc shuts them down. `WARDEN_AUTO_GC=0` disables. The child gets the context's
 * env, so it gcs the same `WARDEN_HOME`.
 */
export function maybeAutoGc(
	ctx: CommandContext,
	self: string[] = selfCommand(),
	run: (cmd: string[]) => void = (cmd) => spawnDetached(cmd, { ...process.env, ...ctx.env }),
	opts: { nice?: string[]; pidAlive?: PidAlive } = {}
): void {
	if (ctx.env.WARDEN_AUTO_GC === "0" || !backgroundAllowed(ctx.env)) return;
	const store = ctx.store();
	const now = ctx.now();
	const due = store.transaction(() => {
		const last = Number(store.getMeta(AUTO_GC_META_KEY) ?? 0);
		if (now - last < AUTO_GC_INTERVAL_MS) return false;
		store.setMeta(AUTO_GC_META_KEY, String(now));
		return true;
	});
	if (!due) return;
	const work = store.gcWork(now, DEFAULT_IDLE_MS, opts.pidAlive ?? processAlive);
	if (work.staleLeases === 0 && work.idleDevices === 0 && !cacheOverCap(ctx)) return;
	run([...(opts.nice ?? niceCommand()), ...self, "gc", "--quiet"]);
}

/** The build cache is over the cap gc would prune it to; a bad `WARDEN_MAX_CACHE_SIZE` (gc skips the prune) is not. */
function cacheOverCap(ctx: CommandContext): boolean {
	const cap = cacheCap(undefined, ctx.env).bytes;
	return cap.success && cacheTotal(ctx.store()) > cap.data;
}
