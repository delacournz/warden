import { type Cost, capacityMath, ZERO_COST } from "@delacour/warden-leasing/capacity";
import { CAPACITY_PLATFORMS, CapacityDepsBuilder, capacityEnv } from "@delacour/warden-leasing/capacity-deps";
import { ownerResolver } from "@delacour/warden-leasing/owner";
import type { CapacityJson } from "@delacour/warden-sdk/contracts/capacity";
import type { InventoryDevice, Platform } from "@delacour/warden-store/types";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { leaseHostBuilder } from "../lease-host";
import { output } from "../output";

type PlatformUsage = CapacityJson["usage"]["ios"];

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

/** `warden capacity`: what the machine can run, what is running, and why a claim would queue. */
async function capacity(ctx: CommandContext, json: boolean): Promise<number> {
	const enabled = capacityEnv.enabled(ctx.env);
	const basis = await new CapacityDepsBuilder(leaseHostBuilder.leaseHostFromContext(ctx)).basis();
	const { host, budget, config } = basis;
	const owner = ownerResolver.resolve(ctx);
	const inventory = await new CapacityDepsBuilder(leaseHostBuilder.leaseHostFromContext(ctx)).hostInventoryOf(owner)();
	const devices = inventory.success ? inventory.data : [];
	const pressure = await new CapacityDepsBuilder(leaseHostBuilder.leaseHostFromContext(ctx)).pressure()();
	const costs = Object.fromEntries(CAPACITY_PLATFORMS.map((p) => [p, capacityMath.deviceCost(p, config)])) as Record<
		Platform,
		Cost
	>;
	const slimCosts = Object.fromEntries(
		CAPACITY_PLATFORMS.map((p) => [p, capacityMath.deviceCost(p, config, { slim: true })])
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
	const live = devices.filter((d) => d.state === "booted" || d.state === "booting");
	const used = capacityMath.totalCost(
		live.map((d) => d.platform),
		config,
		live.map((d) => d.platform === "ios" && slimmed.has(d.id))
	);
	const concurrent = Object.fromEntries(
		CAPACITY_PLATFORMS.map((p) => [p, capacityMath.maxConcurrent(p, budget, config)])
	) as Record<Platform, number>;
	const verdict = capacityMath.fits(used, ZERO_COST, budget);
	const why = capacityMath.explain(verdict, used, budget);
	const cpuLimit = Math.min(budget.cpu, budget.maxUnits);

	const data: CapacityJson = {
		enabled,
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
		`budget    ${Math.round(budget.memMb / MB_PER_GB)} GB · ${cpuLimit.toFixed(1)} cpu units${enabled ? "" : color.yellow("  (capacity gate OFF: WARDEN_CAPACITY=off)")}`,
		`usage     ${used.cpu.toFixed(1)} units · ${Math.round(used.memMb)} MB booted`,
		`pressure  ${data.pressure}`,
		"",
		output.table(ctx, ["PLATFORM", "BOOTED", "COST/DEVICE", "MAX ALONE"], rows),
		"",
		why,
	].join("\n");
	output.emit(ctx, json, data, text, { scope: "capacity", detail: enabled ? "on" : "off" });
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
