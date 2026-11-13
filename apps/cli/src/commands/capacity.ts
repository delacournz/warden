import {
	type Budget,
	type Cost,
	capacityBlock,
	deviceCost,
	explain,
	fits,
	hostUsage,
	maxConcurrent,
	ZERO_COST,
} from "@delacour/warden-core/capacity";
import type { CapacityReason } from "@delacour/warden-core/claim-errors";
import type { InventoryDevice, Platform } from "@delacour/warden-core/types";
import { warmEnabled } from "@delacour/warden-core/warm-pool";
import { CAPACITY_PLATFORMS, capacityEnabled, hostInventoryOf, pressureOf, readCapacityBasis } from "../capacity-deps";
import { resolveOwner } from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, table } from "../output";
import { readWarmPlan } from "../warm-pool";

type PlatformUsage = { booted: number; warden: number; foreign: number; memMb: number; units: number };

const MB_PER_GB = 1024;

/** `slimmed` = iOS ids whose store record says `sim slim` ran; those cost the slim figure. */
function usageOf(
	devices: readonly InventoryDevice[],
	platform: Platform,
	cost: Cost,
	slimCost: Cost,
	slimmed: ReadonlySet<string>
): PlatformUsage {
	const booted = devices.filter((d) => d.platform === platform && (d.state === "booted" || d.state === "booting"));
	const warden = booted.filter((d) => d.wardenCreated || d.golden === true).length;
	return {
		booted: booted.length,
		warden,
		foreign: booted.length - warden,
		memMb: booted.reduce((sum, d) => sum + (slimmed.has(d.id) ? slimCost : cost).memMb, 0),
		units: booted.length * cost.cpu,
	};
}

/**
 * Per platform, what booting one more device would run out of now (null = it fits): the claim gate's own
 * `fits` + `capacityBlock` over the same usage, with a new iOS sim counted slim as claims count it.
 */
function nextBootBlock(
	used: Cost,
	slimCosts: Record<Platform, Cost>,
	costs: Record<Platform, Cost>,
	budget: Budget,
	held: boolean
): Record<Platform, CapacityReason | null> {
	return Object.fromEntries(
		CAPACITY_PLATFORMS.map((p) => {
			const need = p === "ios" ? slimCosts.ios : costs[p];
			return [p, capacityBlock(fits(used, need, budget), held) ?? null];
		})
	) as Record<Platform, CapacityReason | null>;
}

/** `blocked   ios cpu-budget · android cpu-budget` for the platforms whose next boot would not fit. */
function blockedLine(blocked: Record<Platform, CapacityReason | null>): string[] {
	const parts = CAPACITY_PLATFORMS.flatMap((p) => (blocked[p] === null ? [] : [`${p} ${blocked[p]}`]));
	return parts.length === 0 ? [] : [`blocked   ${parts.join(" · ")}`];
}

/** `warden capacity`: what the machine can run, what is running, and why a claim would queue. */
async function capacity(ctx: CommandContext, json: boolean): Promise<number> {
	const enforced = capacityEnabled(ctx.env);
	const basis = await readCapacityBasis(ctx);
	const { host, budget, config } = basis;
	const owner = resolveOwner(ctx);
	const inventory = await hostInventoryOf(ctx, owner)();
	const devices = inventory.success ? inventory.data : [];
	const pressure = await pressureOf(ctx)();
	const costs = Object.fromEntries(CAPACITY_PLATFORMS.map((p) => [p, deviceCost(p, config)])) as Record<Platform, Cost>;
	const slimCosts = Object.fromEntries(
		CAPACITY_PLATFORMS.map((p) => [p, deviceCost(p, config, { slim: true })])
	) as Record<Platform, Cost>;
	const slimmed = new Set(
		ctx
			.store()
			.listDevices("ios")
			.filter((r) => r.slimmedAt !== undefined)
			.map((r) => r.id)
	);
	const usage = Object.fromEntries(
		CAPACITY_PLATFORMS.map((p) => [p, usageOf(devices, p, costs[p], slimCosts[p], slimmed)])
	) as Record<Platform, PlatformUsage>;
	const used = hostUsage(devices, config, slimmed);
	const concurrent = Object.fromEntries(CAPACITY_PLATFORMS.map((p) => [p, maxConcurrent(p, budget, config)])) as Record<
		Platform,
		number
	>;
	const verdict = fits(used, ZERO_COST, budget);
	const why = explain(verdict, used, budget);
	const cpuLimit = Math.min(budget.cpu, budget.maxUnits);

	const warmOn = warmEnabled(ctx.env);
	const warmPlan = warmOn ? await readWarmPlan(ctx, owner) : undefined;
	const warmRows = (warmPlan?.rows ?? []).map(({ platform, profile, target, actual, peak }) => ({
		platform,
		profile,
		target,
		actual,
		peak,
	}));

	const data = {
		enforced,
		/** same as `enforced`; kept for scripts written before limits became opt-in */
		enabled: enforced,
		warm: { enabled: warmOn, rows: warmRows },
		host: {
			os: host.os,
			totalMemGb: Math.round((host.totalMem / 1024 ** 3) * 10) / 10,
			perfCores: host.perfCores,
			effCores: host.effCores,
		},
		budget: {
			memMb: Math.round(budget.memMb),
			cpu: budget.cpu,
			maxUnits: Number.isFinite(budget.maxUnits) ? budget.maxUnits : null,
		},
		config,
		cost: costs,
		slimCost: { ios: slimCosts.ios },
		usage: { total: { memMb: Math.round(used.memMb), units: used.cpu }, ...usage },
		maxConcurrent: concurrent,
		pressure: pressure.success ? pressure.data : "unknown",
		explain: why,
		blocked: nextBootBlock(used, slimCosts, costs, budget, pressure.success && pressure.data !== "normal"),
	};

	const { color } = ctx.ui;
	const rows = CAPACITY_PLATFORMS.map((p) => [
		p,
		`${usage[p].booted} (${usage[p].warden} warden, ${usage[p].foreign} foreign)`,
		`${costs[p].memMb} MB${p === "ios" ? ` (slim ${slimCosts.ios.memMb} MB)` : ""} / ${costs[p].cpu} cpu`,
		String(concurrent[p]),
	]);
	const text = [
		`host      ${host.os} · ${data.host.totalMemGb} GB · ${host.perfCores} perf + ${host.effCores} eff cores`,
		`budget    ${Math.round(budget.memMb / MB_PER_GB)} GB · ${cpuLimit.toFixed(1)} cpu units${enforced ? color.dim("  (limits enforced)") : color.yellow("  (limits not enforced: claims boot at once; WARDEN_CAPACITY=on enforces them)")}`,
		`usage     ${used.cpu.toFixed(1)} units · ${Math.round(used.memMb)} MB booted`,
		`pressure  ${data.pressure}`,
		...(warmOn
			? [
					warmRows.length === 0
						? "warm      on · no demand in the last 24 h"
						: `warm      on · ${warmRows.map((r) => `${r.platform}/${r.profile} ${r.actual}/${r.target}`).join(", ")} (booted/target)`,
				]
			: []),
		...blockedLine(data.blocked),
		"",
		table(ctx, ["PLATFORM", "BOOTED", "COST/DEVICE", "MAX ALONE"], rows),
		"",
		why,
	].join("\n");
	emit(ctx, json, data, text, { scope: "capacity", detail: enforced ? "enforced" : "not enforced" });
	return 0;
}

export const capacityCommand = defineCommand({
	name: "capacity",
	group: "Lease",
	summary: "machine capacity: budget, booted devices (foreign too), per-device cost, memory pressure",
	register: (cmd, ctx, done) => {
		cmd
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await capacity(ctx, opts.json === true)));
	},
});
