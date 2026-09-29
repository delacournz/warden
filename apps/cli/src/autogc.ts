import { spawn } from "node:child_process";
import type { CommandContext } from "./context";

/** Background `warden gc` runs at most this often, machine-wide. */
export const AUTO_GC_INTERVAL_MS = 10 * 60_000;
const META_KEY = "auto_gc_spawned_at";

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
	spawn(bin, args, { detached: true, stdio: "ignore", env }).unref();
}

/**
 * Kick off `warden gc --quiet` if none was started in the last `AUTO_GC_INTERVAL_MS` (throttle kept
 * in the store, so every hook/claim across every process shares it). This is what reaps sims left
 * behind by sessions that died without a SessionEnd — their leases go stale, gc shuts them down.
 * `WARDEN_AUTO_GC=0` disables. The child gets the context's env, so it gcs the same `WARDEN_HOME`.
 */
export function maybeAutoGc(
	ctx: CommandContext,
	self: string[] = selfCommand(),
	run: (cmd: string[]) => void = (cmd) => spawnDetached(cmd, { ...process.env, ...ctx.env })
): void {
	if (ctx.env.WARDEN_AUTO_GC === "0" || !backgroundAllowed(ctx.env)) return;
	const store = ctx.store();
	const now = ctx.now();
	const due = store.transaction(() => {
		const last = Number(store.getMeta(META_KEY) ?? 0);
		if (now - last < AUTO_GC_INTERVAL_MS) return false;
		store.setMeta(META_KEY, String(now));
		return true;
	});
	if (due) run([...self, "gc", "--quiet"]);
}
