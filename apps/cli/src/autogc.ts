import { spawn } from "node:child_process";
import { statfsSync } from "node:fs";
import { cacheCap, cacheTotal } from "@delacour/warden-core/builds/prune";
import { DEFAULT_IDLE_MS } from "@delacour/warden-core/config.defaults";
import { diskThresholds } from "@delacour/warden-core/disk";
import { androidSnapshotsDue } from "@delacour/warden-core/golden/android-snapshot-pending";
import { type PidAlive, processAlive } from "@delacour/warden-core/liveness";
import { ephemeralEnabled } from "@delacour/warden-core/shutdown-policy";
import { warmEnabled } from "@delacour/warden-core/warm-pool";
import type { CommandContext } from "./context";
import { diskConfigFromEnv, diskGateEnabled } from "./disk-deps";
import { goldenPruneDue } from "./golden-prune";

/** Background `warden gc` is considered at most this often, machine-wide. */
export const AUTO_GC_INTERVAL_MS = 10 * 60_000;
/** store meta key holding when auto-gc was last considered (the throttle) */
export const AUTO_GC_META_KEY = "auto_gc_checked_at";
/** A low disk starts a pass at once, but never more often than this. */
export const LOW_DISK_GC_INTERVAL_MS = 60_000;
/** store meta key holding when a low-disk pass was last started */
export const LOW_DISK_GC_META_KEY = "auto_gc_lowdisk_at";
/** store meta key `warden gc` stamps after an ephemeral sim sweep; absent = sims an older warden left may be on disk */
export const EPHEMERAL_SWEPT_META_KEY = "ephemeral_swept_at";
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
 * process shares it) it looks at the store: a lease whose owner died, a warden device that went
 * idle since the last pass, a build cache over its cap (one `SUM` over the builds table), or an AVD a claim
 * cold-booted for want of a quick-boot snapshot (not under `CI`), or ephemeral sims on and never swept on this machine
 * (`EPHEMERAL_SWEPT_META_KEY`: the backlog of shut-down sims an older warden kept), or a day since gc last pruned stale
 * goldens (`goldenPruneDue`). Nothing there, nothing is spawned (a pass is a full warden process,
 * ~100 MB). This is what reaps sims left behind by sessions that died without a SessionEnd: their
 * leases go stale, gc shuts them down. Free space under the disk floor skips the throttle and the "something to do" check (once per minute; one `statfs`).
 * `WARDEN_AUTO_GC=0` disables (`WARDEN_DISK=off` the low-disk trigger). The child gets the context's
 * env, so it gcs the same `WARDEN_HOME`.
 */
export function maybeAutoGc(
	ctx: CommandContext,
	self: string[] = selfCommand(),
	run: (cmd: string[]) => void = (cmd) => spawnDetached(cmd, { ...process.env, ...ctx.env }),
	opts: { nice?: string[]; pidAlive?: PidAlive; volume?: () => Volume | undefined } = {}
): void {
	if (ctx.env.WARDEN_AUTO_GC === "0" || !backgroundAllowed(ctx.env)) return;
	const store = ctx.store();
	const now = ctx.now();
	if (lowDiskDue(ctx, now, opts.volume ?? (() => volumeOf(ctx.env.HOME)))) {
		run([...(opts.nice ?? niceCommand()), ...self, "gc", "--quiet"]);
		return;
	}
	const due = store.transaction(() => {
		const last = Number(store.getMeta(AUTO_GC_META_KEY) ?? 0);
		if (now - last < AUTO_GC_INTERVAL_MS) return false;
		store.setMeta(AUTO_GC_META_KEY, String(now));
		return true;
	});
	if (!due) return;
	const work = store.gcWork(now, DEFAULT_IDLE_MS, opts.pidAlive ?? processAlive);
	if (
		work.staleLeases === 0 &&
		work.idleDevices === 0 &&
		!cacheOverCap(ctx) &&
		!androidSnapshotsDue(store, ctx.env, now) &&
		!(ephemeralEnabled(ctx.env) && store.getMeta(EPHEMERAL_SWEPT_META_KEY) === undefined) &&
		!goldenPruneDue(store, ctx.env, now) &&
		!warmEnabled(ctx.env)
	)
		return;
	run([...(opts.nice ?? niceCommand()), ...self, "gc", "--quiet"]);
}

/** The build cache is over the cap gc would prune it to; a bad `WARDEN_MAX_CACHE_SIZE` (gc skips the prune) is not. */
function cacheOverCap(ctx: CommandContext): boolean {
	const cap = cacheCap(undefined, ctx.env).bytes;
	return cap.success && cacheTotal(ctx.store()) > cap.data;
}

type Volume = { freeBytes: number; totalBytes: number };

/** Free and total bytes of the volume holding `home`, from one `statfs` (no process); undefined when unreadable. */
function volumeOf(home: string | undefined): Volume | undefined {
	if (!home) return undefined;
	try {
		const fs = statfsSync(home);
		return { freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize };
	} catch {
		return undefined;
	}
}

/**
 * Free space under the floor (`low-free` in `warden disk`): stamp both throttles and say a pass should start
 * now, at most once per `LOW_DISK_GC_INTERVAL_MS`. The pass sweeps orphans, prunes the build cache and shuts down idle devices.
 */
function lowDiskDue(ctx: CommandContext, now: number, volume: () => Volume | undefined): boolean {
	if (!diskGateEnabled(ctx.env)) return false;
	const vol = volume();
	if (!vol || vol.freeBytes >= diskThresholds(vol.totalBytes, diskConfigFromEnv(ctx.env).config).floorBytes)
		return false;
	const store = ctx.store();
	return store.transaction(() => {
		if (now - Number(store.getMeta(LOW_DISK_GC_META_KEY) ?? 0) < LOW_DISK_GC_INTERVAL_MS) return false;
		store.setMeta(LOW_DISK_GC_META_KEY, String(now));
		store.setMeta(AUTO_GC_META_KEY, String(now));
		return true;
	});
}
