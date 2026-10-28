import { findOrphans } from "@delacour/warden-core/builds/orphans";
import { cacheCap, cacheTotal, formatSize } from "@delacour/warden-core/builds/prune";
import { totalCost } from "@delacour/warden-core/capacity";
import {
	type DiskFacts,
	type DiskLevel,
	type DiskReason,
	type DiskThresholds,
	diskThresholds,
	judgeDisk,
	readDiskFacts,
} from "@delacour/warden-core/disk";
import {
	type HostFacts,
	type HostOs,
	type MemoryPressure,
	memoryPressure,
	readHostFacts,
} from "@delacour/warden-core/host";
import { auditMachineSims } from "@delacour/warden-core/sims/prune";
import { DEFAULT_SIM_IDLE_MS, DEFAULT_SIM_STALE_MS } from "@delacour/warden-core/sims/sims.defaults";
import { capacityConfigFromEnv, hostInventoryOf } from "../capacity-deps";
import { resolveOwner } from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { diskConfigFromEnv, diskGateEnabled } from "../disk-deps";
import { emit, table } from "../output";
import { simsDeps } from "./sims-audit";
import { summarizeWorktrees } from "./worktrees";

/** Space warden itself can give back, one entry per source; each carries the one-line `fix` the report prints. */
export type DiskReclaimable =
	| { kind: "builds"; bytes: number; capBytes: number | null; overCapBytes: number; fix: string }
	| { kind: "sims"; bytes: number; count: number; fix: string }
	| { kind: "orphans"; bytes: number; derivedData: number; xctestDevices: number; fix: string }
	| { kind: "worktrees"; bytes: number; removable: number; total: number; fix: string };

export type DiskReasonRow = DiskReason & { fix: string };

const DELETE_CAVEAT = "deleting files won't stop swap refilling the disk — fix the memory side first:";

/** The one-line remedy for a warning. Never a command warden runs for you (`sudo` is the user's). */
export function fixFor(reason: DiskReason): string {
	switch (reason.kind) {
		case "swap":
			return "close idle devices: `warden gc --idle 0` (swap only fully clears on reboot)";
		case "os-update-snapshots":
			return "install the staged macOS update (reboot) to release them";
		case "tm-snapshots":
			return "run `sudo tmutil deletelocalsnapshots /` yourself (warden never runs sudo)";
		case "low-free":
			return "`warden gc` · `warden builds rm <hash…>` · `warden sims prune`";
		case "uptime":
			return "reboot (clears swap and compressor state)";
	}
}

const isMemoryReason = (r: DiskReason): boolean =>
	r.kind === "swap" || r.kind === "os-update-snapshots" || r.kind === "tm-snapshots";

export function describeReason(reason: DiskReason): string {
	switch (reason.kind) {
		case "swap":
			return `swap ${formatSize(reason.swapUsedBytes)} used (warn above ${formatSize(reason.warnBytes)})`;
		case "os-update-snapshots":
			return `${reason.count} OS-update snapshot${reason.count === 1 ? "" : "s"} pinning deleted blocks`;
		case "tm-snapshots":
			return `${reason.count} Time Machine local snapshot${reason.count === 1 ? "" : "s"}`;
		case "low-free":
			return `free space ${formatSize(reason.freeBytes)} below ${formatSize(reason.floorBytes)} (critical ${formatSize(reason.criticalBytes)})`;
		case "uptime":
			return `up ${reason.days} days`;
	}
}

type Devices = { booted: number; estMemMb: number };

async function bootedDevices(ctx: CommandContext): Promise<Devices> {
	const inventory = await hostInventoryOf(ctx, resolveOwner(ctx))();
	const live = (inventory.success ? inventory.data : []).filter((d) => d.state === "booted" || d.state === "booting");
	const slimmed = new Set(
		ctx
			.store()
			.listDevices("ios")
			.filter((r) => r.slimmedAt !== undefined)
			.map((r) => r.id)
	);
	const { config } = capacityConfigFromEnv(ctx.env);
	const used = totalCost(
		live.map((d) => d.platform),
		config,
		live.map((d) => d.platform === "ios" && slimmed.has(d.id))
	);
	return { booted: live.length, estMemMb: Math.round(used.memMb) };
}

/** DerivedData of deleted projects and stale XCTest clones: what `warden gc` sweeps. macOS only. */
async function orphansOf(ctx: CommandContext, os: HostOs): Promise<DiskReclaimable[]> {
	const home = ctx.env.HOME;
	if (os !== "darwin" || !home) return [];
	const found = await findOrphans({ home, exec: ctx.exec, now: ctx.now(), platform: "darwin" });
	if (found.length === 0) return [];
	return [
		{
			kind: "orphans",
			bytes: found.reduce((sum, e) => sum + e.bytes, 0),
			derivedData: found.filter((e) => e.kind === "derived-data").length,
			xctestDevices: found.filter((e) => e.kind === "xctest-devices").length,
			fix: "`warden gc --dry-run` to list, then `warden gc`",
		},
	];
}

/** Merged git worktrees `warden worktrees --apply` removes: no fetch, only those sized. Nothing to say when there are no worktrees. */
async function worktreesOf(ctx: CommandContext): Promise<DiskReclaimable[]> {
	const { summary } = await summarizeWorktrees(ctx);
	if (summary.total === 0) return [];
	return [
		{
			kind: "worktrees",
			bytes: summary.removableBytes,
			removable: summary.removable,
			total: summary.total,
			fix: "`warden worktrees` to review, `--apply` removes merged",
		},
	];
}

async function reclaimableOf(ctx: CommandContext, os: HostOs): Promise<DiskReclaimable[]> {
	const list: DiskReclaimable[] = [...(await orphansOf(ctx, os)), ...(await worktreesOf(ctx))];
	const total = cacheTotal(ctx.store());
	if (total > 0) {
		const cap = cacheCap(undefined, ctx.env).bytes;
		const capBytes = cap.success ? cap.data : null;
		list.push({
			kind: "builds",
			bytes: total,
			capBytes,
			overCapBytes: capBytes === null ? 0 : Math.max(0, total - capBytes),
			fix: "`warden builds prune` (to the cap) · `warden builds rm <hash…>`",
		});
	}
	const audit = await auditMachineSims(simsDeps(ctx), { idleMs: DEFAULT_SIM_IDLE_MS, staleMs: DEFAULT_SIM_STALE_MS });
	if (audit.success) {
		const count = audit.data.entries.filter((e) => e.verdict.kind === "delete").length;
		if (count > 0)
			list.push({
				kind: "sims",
				bytes: audit.data.reclaimableBytes,
				count,
				fix: "`warden sims prune --dry-run`, then `--yes`",
			});
	}
	return list;
}

type Report = {
	enabled: boolean;
	level: DiskLevel;
	thresholds: DiskThresholds;
	free: { freeBytes: number; totalBytes: number } | null;
	swapUsedBytes: number | null;
	pressure: MemoryPressure | "unknown";
	devices: Devices;
	snapshots: { osUpdate: number; timeMachine: number } | null;
	uptimeDays: number | null;
	reasons: DiskReasonRow[];
	reclaimable: DiskReclaimable[];
};

function buildReport(
	ctx: CommandContext,
	facts: DiskFacts,
	parts: { pressure: Report["pressure"]; devices: Devices; reclaimable: DiskReclaimable[] }
): Report {
	const { config } = diskConfigFromEnv(ctx.env);
	const verdict = judgeDisk(facts, config);
	const hasSpace = facts.freeBytes !== undefined && facts.totalBytes !== undefined;
	return {
		enabled: diskGateEnabled(ctx.env),
		level: verdict.level,
		thresholds: diskThresholds(facts.totalBytes, config),
		free: hasSpace ? { freeBytes: facts.freeBytes ?? 0, totalBytes: facts.totalBytes ?? 0 } : null,
		swapUsedBytes: facts.swapUsedBytes ?? null,
		pressure: parts.pressure,
		devices: parts.devices,
		snapshots: facts.snapshots ?? null,
		uptimeDays: facts.uptimeDays ?? null,
		reasons: verdict.reasons.map((r) => ({ ...r, fix: fixFor(r) })),
		reclaimable: parts.reclaimable,
	};
}

function factsText(ctx: CommandContext, r: Report): string[] {
	const { color } = ctx.ui;
	const t = r.thresholds;
	const free = r.free
		? `${formatSize(r.free.freeBytes)} free of ${formatSize(r.free.totalBytes)}`
		: color.dim("unknown");
	const snaps = r.snapshots ? `${r.snapshots.osUpdate} OS update · ${r.snapshots.timeMachine} Time Machine` : "unknown";
	return [
		`disk      ${free}`,
		`swap      ${r.swapUsedBytes === null ? "unknown" : `${formatSize(r.swapUsedBytes)} used`}`,
		`pressure  ${r.pressure}`,
		`devices   ${r.devices.booted} booted · ~${r.devices.estMemMb} MB`,
		`snapshots ${snaps}`,
		`uptime    ${r.uptimeDays === null ? "unknown" : `${r.uptimeDays} days`}`,
		`thresholds free < ${formatSize(t.floorBytes)} warns, < ${formatSize(t.criticalBytes)} critical · swap > ${formatSize(t.swapWarnBytes)} warns${r.enabled ? "" : color.yellow("  (disk gate OFF: WARDEN_DISK=off)")}`,
	];
}

function warningsText(ctx: CommandContext, r: Report): string[] {
	const { color } = ctx.ui;
	if (r.reasons.length === 0) return [color.green("disk healthy")];
	const lines: string[] = [];
	if (r.reasons.some(isMemoryReason)) lines.push(color.yellow(DELETE_CAVEAT));
	for (const reason of r.reasons) {
		const paint = reason.kind === "low-free" && r.level === "critical" ? color.red : color.yellow;
		lines.push(`${paint(describeReason(reason))}\n  → ${reason.fix}`);
	}
	return lines;
}

function reclaimableText(ctx: CommandContext, r: Report): string[] {
	if (r.reclaimable.length === 0) return [];
	const rows = r.reclaimable.map((item) => [item.kind, formatSize(item.bytes), reclaimableNote(item), item.fix]);
	return ["", "warden can give back:", table(ctx, ["SOURCE", "SIZE", "NOTE", "FIX"], rows)];
}

function reclaimableNote(item: DiskReclaimable): string {
	switch (item.kind) {
		case "builds":
			return item.capBytes === null
				? "cache"
				: `cap ${formatSize(item.capBytes)}, ${formatSize(item.overCapBytes)} over`;
		case "sims":
			return `${item.count} deletable sim${item.count === 1 ? "" : "s"}`;
		case "worktrees":
			return `${item.removable} merged of ${item.total} worktree${item.total === 1 ? "" : "s"}`;
		case "orphans":
			return `${item.derivedData} DerivedData of deleted projects · ${item.xctestDevices} XCTest clone set`;
	}
}

/** `warden disk`: read-only. What fills the disk besides files, then what warden can give back. */
async function disk(ctx: CommandContext, json: boolean): Promise<number> {
	for (const problem of diskConfigFromEnv(ctx.env).problems) ctx.err(`warden: ${problem}`);
	const host: HostFacts = await (ctx.hostFacts?.() ?? readHostFacts(ctx.exec));
	const [facts, pressure, devices, reclaimable] = await Promise.all([
		readDiskFacts(ctx.exec, { os: host.os, home: ctx.env.HOME ?? "", now: ctx.now() }),
		memoryPressure(ctx.exec, host.os),
		bootedDevices(ctx),
		reclaimableOf(ctx, host.os),
	]);
	const report = buildReport(ctx, facts, {
		pressure: pressure.success ? pressure.data : "unknown",
		devices,
		reclaimable,
	});
	const text = [...factsText(ctx, report), "", ...warningsText(ctx, report), ...reclaimableText(ctx, report)].join(
		"\n"
	);
	emit(ctx, json, report, text, { scope: "disk", detail: report.level });
	return 0;
}

export const diskCommand = defineCommand({
	name: "disk",
	group: "Lease",
	summary: "host disk health: free space, swap, snapshots, uptime, what warden can reclaim (read-only)",
	register: (cmd, ctx, done) => {
		cmd.option("--json", "machine-readable output").action(async (opts) => done(await disk(ctx, opts.json === true)));
	},
});
