import { DEFAULT_IDLE_MS } from "@warden/core/config.defaults";
import { formatDuration, parseDuration } from "@warden/core/duration";
import { isLeaseAlive, processAlive } from "@warden/core/liveness";
import type { Owner, Platform } from "@warden/core/types";
import { ok, type Result } from "@warden/types/result";
import { resolveOwner } from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { shutdownReleasedDevices } from "../device-shutdown";
import { emit } from "../output";
import { providerFor } from "../providers";
import { withSpinner } from "../spinner-context";

const PLATFORMS: readonly Platform[] = ["ios", "android"];

type ShutDevice = { platform: Platform; id: string; name: string };

type GcPlan = {
	now: number;
	idleMs: number;
	leased: Set<string>;
	shutdown: ShutDevice[];
	forgotten: ShutDevice[];
	notes: string[];
};

/** Shut down this platform's booted, unleased, idle warden-created devices. */
async function gcPlatform(ctx: CommandContext, platform: Platform, owner: Owner, plan: GcPlan): Promise<void> {
	const records = ctx.store().listDevices(platform);
	if (records.length === 0) return;
	const provider = providerFor(platform, ctx, owner);
	const inventory = await provider.inventory();
	if (!inventory.success) {
		plan.notes.push(`${platform}: skipped (${inventory.error})`);
		return;
	}
	const booted = new Set(inventory.data.filter((d) => d.state !== "shutdown").map((d) => d.id));
	if (platform === "android") {
		const listed = new Set(inventory.data.map((d) => d.id));
		for (const r of records) {
			if (listed.has(r.id) || plan.leased.has(`${platform}:${r.id}`)) continue;
			ctx.store().forgetDevice(platform, r.id);
			plan.forgotten.push({ platform, id: r.id, name: r.name });
		}
	}
	const idle = records.filter(
		(r) => booted.has(r.id) && !plan.leased.has(`${platform}:${r.id}`) && plan.now - r.lastUsedAt >= plan.idleMs
	);
	for (const record of idle) {
		const result = await provider.shutdown(record.id);
		if (result.success) plan.shutdown.push({ platform, id: record.id, name: record.name });
		else plan.notes.push(`shutdown ${record.id} failed: ${result.error}`);
	}
}

function parseIdle(raw: string | undefined): Result<number> {
	return raw === undefined ? ok(DEFAULT_IDLE_MS) : parseDuration(raw);
}

type GcOpts = { idle?: string; quiet?: true; json?: true };

/**
 * Stale leases (owner died without releasing, e.g. a Claude session killed before SessionEnd) are
 * reclaimed, and their devices shut down when the shutdown policy allows (warden-created, or booted
 * by that owner). Then shut down warden-created devices (store `devices` table) that are
 * booted, unleased and idle longer than `--idle`. Foreign devices are never touched; nothing is
 * ever deleted. Android records whose emulator has exited (and is unleased) are forgotten — an
 * emulator can't be rebooted in place. A platform whose provider fails is skipped with a note.
 */
async function gc(ctx: CommandContext, opts: GcOpts): Promise<number> {
	const { color } = ctx.ui;
	const idle = parseIdle(opts.idle);
	if (!idle.success) {
		ctx.err(color.red(`warden gc: ${idle.error}`));
		return 1;
	}
	const store = ctx.store();
	const now = ctx.now();
	const owner = resolveOwner(ctx);
	const stale = store.listLeases().filter((l) => l.resource.kind === "device" && !isLeaseAlive(l, now, processAlive));
	const shutDownIdle = async (sctx: CommandContext): Promise<GcPlan & { reclaimed: string[] }> => {
		const orphaned = await shutdownReleasedDevices(sctx, stale, owner);
		const reclaimed = store.reclaimStale(now, processAlive);
		const leased = new Set(
			store
				.listLeases()
				.flatMap((l) => (l.resource.kind === "device" ? [`${l.resource.platform}:${l.resource.id}`] : []))
		);
		const plan: GcPlan = {
			now,
			idleMs: idle.data,
			leased,
			shutdown: stale.flatMap((l) =>
				l.resource.kind === "device" && orphaned.shutdown.includes(l.resource.id)
					? [{ platform: l.resource.platform, id: l.resource.id, name: l.resource.name }]
					: []
			),
			forgotten: [],
			notes: orphaned.notes,
		};
		for (const platform of PLATFORMS) await gcPlatform(sctx, platform, owner, plan);
		return { ...plan, reclaimed };
	};
	// `--quiet` is the detached auto-gc: no terminal, so no spinner.
	const { reclaimed, shutdown, forgotten, notes } = opts.quiet
		? await shutDownIdle(ctx)
		: await withSpinner(ctx, "shutting down idle devices…", shutDownIdle);
	store.setMeta("last_gc_at", String(now));
	if (opts.quiet) return 0;
	const text = [
		`reclaimed ${reclaimed.length} stale lease${reclaimed.length === 1 ? "" : "s"}`,
		shutdown.length > 0
			? color.green(`shut down ${shutdown.map((d) => d.name).join(" ")} (idle > ${formatDuration(idle.data)})`)
			: color.dim("no idle devices"),
		...(forgotten.length > 0
			? [color.yellow(`forgot exited emulators ${forgotten.map((d) => d.name).join(" ")}`)]
			: []),
		...notes.map((n) => color.yellow(n)),
	].join("\n");
	emit(ctx, opts.json === true, { reclaimed, shutdown, forgotten, notes }, text);
	return 0;
}

export const gcCommand = defineCommand({
	name: "gc",
	summary: "reclaim stale leases; shut down idle warden devices (never deletes)",
	register: (cmd, ctx, done) => {
		cmd
			.option(
				"--idle <duration>",
				`shut down unleased warden devices idle this long (default: ${formatDuration(DEFAULT_IDLE_MS)})`
			)
			.option("--quiet", "print nothing (background auto-gc)")
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await gc(ctx, opts)));
	},
});
