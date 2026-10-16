import { DEFAULT_IDLE_MS } from "@delacour/warden-core/config.defaults";
import { formatDuration, parseDuration } from "@delacour/warden-core/duration";
import { isLeaseAlive, processAlive } from "@delacour/warden-core/liveness";
import { staleShutdownBlock } from "@delacour/warden-core/shutdown-policy";
import type { Owner, Platform } from "@delacour/warden-core/types";
import { ok, type Result } from "@delacour/warden-types/result";
import { stopHelperAfter } from "../agent-ui/close";
import { sweepDeadHelpers } from "../agent-ui/helper";
import { mapBounded } from "../bounded";
import { resolveOwner } from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { releaseDevices } from "../device-lease";
import { shutdownReleasedDevices } from "../device-shutdown";
import { emit, heading, plural, reportError } from "../output";
import { providerFor } from "../providers";
import { hasForegroundApp } from "../running-apps";
import { withSpinner } from "../spinner-context";

const PLATFORMS: readonly Platform[] = ["ios", "android"];

/** how many idle devices one platform shuts down at once */
const SHUTDOWN_CONCURRENCY = 4;

type ShutDevice = { platform: Platform; id: string; name: string };

/** What a pass reads: when it is, how idle is idle, and which devices someone holds. */
type GcPlan = { now: number; idleMs: number; leased: ReadonlySet<string> };

/** What one platform's pass did. */
type PlatformOutcome = { shutdown: ShutDevice[]; forgotten: ShutDevice[]; notes: string[] };

/**
 * Shut down this platform's booted, unleased, idle warden-created devices, several at a time. Only
 * devices in the store's `devices` table (warden made or launched them) are candidates: a booted
 * device warden does not know is never in the list, however many go down at once.
 */
async function gcPlatform(
	ctx: CommandContext,
	platform: Platform,
	owner: Owner,
	plan: GcPlan
): Promise<PlatformOutcome> {
	const outcome: PlatformOutcome = { shutdown: [], forgotten: [], notes: [] };
	const records = ctx.store().listDevices(platform);
	if (records.length === 0) return outcome;
	const provider = providerFor(platform, ctx, owner);
	const inventory = await provider.inventory();
	if (!inventory.success) {
		outcome.notes.push(`${platform}: skipped (${inventory.error})`);
		return outcome;
	}
	const booted = new Set(inventory.data.filter((d) => d.state !== "shutdown").map((d) => d.id));
	if (platform === "android") {
		const listed = new Set(inventory.data.map((d) => d.id));
		for (const r of records) {
			if (listed.has(r.id) || plan.leased.has(`${platform}:${r.id}`)) continue;
			ctx.store().forgetDevice(platform, r.id);
			outcome.forgotten.push({ platform, id: r.id, name: r.name });
		}
	}
	const idle = records.filter(
		(r) => booted.has(r.id) && !plan.leased.has(`${platform}:${r.id}`) && plan.now - r.lastUsedAt >= plan.idleMs
	);
	const results = await mapBounded(idle, SHUTDOWN_CONCURRENCY, async (record) => ({
		record,
		result: await provider.shutdown(record.id),
	}));
	for (const { record, result } of results) {
		if (result.success) outcome.shutdown.push({ platform, id: record.id, name: record.name });
		else outcome.notes.push(`shutdown ${record.id} failed: ${result.error}`);
	}
	return outcome;
}

function parseIdle(raw: string | undefined): Result<number> {
	return raw === undefined ? ok(DEFAULT_IDLE_MS) : parseDuration(raw);
}

type GcOpts = { idle?: string; quiet?: true; json?: true };

/** Everything a pass reports. */
type GcOutcome = PlatformOutcome & { reclaimed: string[] };

/**
 * Stale leases (owner died without releasing, e.g. a Claude session killed before SessionEnd) are
 * reclaimed, and their devices shut down when the shutdown policy allows (warden-created, or booted
 * by that owner) — unless the lease went stale under 10 min ago or an app is running on the device,
 * which then stays up with its idle clock restarted. Then shut down warden-created devices (store `devices` table) that are
 * booted, unleased and idle longer than `--idle` (both platforms at once, a few devices at a time). Foreign devices are never touched; nothing is
 * ever deleted. Android records whose emulator has exited (and is unleased) are forgotten — an
 * emulator can't be rebooted in place. A platform whose provider fails is skipped with a note.
 */
async function gc(ctx: CommandContext, opts: GcOpts): Promise<number> {
	const { color } = ctx.ui;
	const idle = parseIdle(opts.idle);
	if (!idle.success) {
		reportError(ctx, "gc", idle.error);
		return 1;
	}
	const store = ctx.store();
	const now = ctx.now();
	const owner = resolveOwner(ctx);
	const stale = store.listLeases().filter((l) => l.resource.kind === "device" && !isLeaseAlive(l, now, processAlive));
	const shutDownIdle = async (sctx: CommandContext): Promise<GcOutcome> => {
		// A lease that only just went stale (agent between tool calls) or has an app running keeps its device.
		const orphaned = await shutdownReleasedDevices(sctx, stale, owner, async (lease) => {
			const r = lease.resource;
			if (r.kind !== "device") return undefined;
			return (
				staleShutdownBlock(lease, now, false) ??
				staleShutdownBlock(lease, now, await hasForegroundApp(sctx.exec, r.platform, r.id))
			);
		});
		const staleIds = store
			.listLeases()
			.filter((l) => !isLeaseAlive(l, now, processAlive))
			.map((l) => l.id);
		const reclaimed = (
			await releaseDevices(sctx, staleIds, {
				touch: false,
				only: (l) => !isLeaseAlive(l, now, processAlive),
				after: stopHelperAfter(sctx),
			})
		).map((l) => l.id);
		sweepDeadHelpers(sctx);
		const leased = new Set(
			store
				.listLeases()
				.flatMap((l) => (l.resource.kind === "device" ? [`${l.resource.platform}:${l.resource.id}`] : []))
		);
		for (const l of stale) {
			if (l.resource.kind !== "device" || !orphaned.kept.includes(l.resource.id)) continue;
			// Spared on purpose: restart its idle clock and keep the idle pass off it this run.
			store.touchDevice(l.resource.platform, l.resource.id, now);
			leased.add(`${l.resource.platform}:${l.resource.id}`);
		}
		const plan: GcPlan = { now, idleMs: idle.data, leased };
		const platforms = await Promise.all(PLATFORMS.map((platform) => gcPlatform(sctx, platform, owner, plan)));
		return {
			reclaimed,
			shutdown: [
				...stale.flatMap((l) =>
					l.resource.kind === "device" && orphaned.shutdown.includes(l.resource.id)
						? [{ platform: l.resource.platform, id: l.resource.id, name: l.resource.name }]
						: []
				),
				...platforms.flatMap((p) => p.shutdown),
			],
			forgotten: platforms.flatMap((p) => p.forgotten),
			notes: [...orphaned.notes, ...platforms.flatMap((p) => p.notes)],
		};
	};
	if (!opts.quiet && !opts.json)
		heading(ctx, "gc", `${plural(stale.length, "stale lease")} · idle > ${formatDuration(idle.data)}`);
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
	group: "Lease",
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
