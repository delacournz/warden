import { parseArgs } from "node:util";
import { DEFAULT_IDLE_MS } from "@warden/core/config.defaults";
import { formatDuration, parseDuration } from "@warden/core/duration";
import { processAlive } from "@warden/core/liveness";
import type { Owner, Platform } from "@warden/core/types";
import { ok, type Result } from "@warden/types/result";
import { resolveOwner } from "../claim-flags";
import type { Command, CommandContext } from "../context";
import { emit } from "../output";
import { providerFor } from "../providers";

const USAGE = "warden gc [--idle 20m] [--json]";
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

/**
 * Reclaim stale leases, then shut down warden-created devices (store `devices` table) that are
 * booted, unleased and idle longer than `--idle`. Foreign devices are never touched; nothing is
 * ever deleted. Android records whose emulator has exited (and is unleased) are forgotten — an
 * emulator can't be rebooted in place. A platform whose provider fails is skipped with a note.
 */
async function run(ctx: CommandContext): Promise<number> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(ctx.argv);
	} catch (error) {
		ctx.err(`warden gc: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
		return 1;
	}
	const idle = parseIdle(parsed.values.idle);
	if (!idle.success) {
		ctx.err(`warden gc: ${idle.error}`);
		return 1;
	}
	const store = ctx.store();
	const now = ctx.now();
	const reclaimed = store.reclaimStale(now, processAlive);
	const leased = new Set(
		store.listLeases().flatMap((l) => (l.resource.kind === "device" ? [`${l.resource.platform}:${l.resource.id}`] : []))
	);
	const plan: GcPlan = { now, idleMs: idle.data, leased, shutdown: [], forgotten: [], notes: [] };
	const owner = resolveOwner(ctx);
	for (const platform of PLATFORMS) await gcPlatform(ctx, platform, owner, plan);

	const { shutdown, forgotten, notes } = plan;
	const text = [
		`reclaimed ${reclaimed.length} stale lease${reclaimed.length === 1 ? "" : "s"}`,
		shutdown.length > 0
			? `shut down ${shutdown.map((d) => d.name).join(" ")} (idle > ${formatDuration(idle.data)})`
			: "no idle devices",
		...(forgotten.length > 0 ? [`forgot exited emulators ${forgotten.map((d) => d.name).join(" ")}`] : []),
		...notes,
	].join("\n");
	emit(ctx, parsed.values.json === true, { reclaimed, shutdown, forgotten, notes }, text);
	return 0;
}

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		options: { idle: { type: "string" }, json: { type: "boolean" } },
		allowPositionals: false,
		strict: true,
	});
}

export const gcCommand: Command = {
	name: "gc",
	summary: "reclaim stale leases; shut down idle warden devices (never deletes)",
	usage: USAGE,
	run,
};
