import type { HostFacts } from "./host";
import type { Platform } from "./types";

/** What one booted device (or a set of them) takes from the host. cpu is also the "unit" `max` caps. */
export type Cost = { memMb: number; cpu: number };

/** Overrides from `~/.warden` config / env; every field is optional. */
export type CapacityConfig = {
	/** hard cap on weighted units (cpu cost: 1 per iOS sim, 2 per Android emulator by default) */
	max?: number;
	/** RAM held back for the OS, Metro, xcodebuild, gradle (default: max(8 GB, 25% of total)) */
	headroomGb?: number;
	cost?: Partial<Record<Platform, Partial<Cost>>>;
};

export type Budget = { memMb: number; cpu: number; maxUnits: number };

export type Dimension = "mem" | "cpu" | "max";

export type FitResult =
	| { fits: true; remaining: Cost }
	| { fits: false; binding: Dimension; need: number; available: number };

export const ZERO_COST: Cost = { memMb: 0, cpu: 0 };

/** An Android emulator costs about twice an iOS sim; CAP-7 calibrates these against real RSS. */
export const DEFAULT_COSTS: Record<Platform, Cost> = {
	ios: { memMb: 2048, cpu: 1 },
	android: { memMb: 4096, cpu: 2 },
};

/** Share of performance cores warden may fill, leaving room for Metro / xcodebuild / gradle. */
export const CPU_FACTOR = 0.6;
const MIN_HEADROOM_GB = 8;
const HEADROOM_SHARE = 0.25;
const MB_PER_GB = 1024;
const BYTES_PER_MB = 1024 * 1024;
/** float slack so `10 cores x 0.6` still admits 6 units */
const EPSILON = 1e-9;

export function hostBudget(host: HostFacts, config: CapacityConfig): Budget {
	const totalMb = host.totalMem / BYTES_PER_MB;
	const headroomMb =
		(config.headroomGb ?? Math.max(MIN_HEADROOM_GB, (totalMb / MB_PER_GB) * HEADROOM_SHARE)) * MB_PER_GB;
	return {
		memMb: Math.max(0, totalMb - headroomMb),
		cpu: host.perfCores * CPU_FACTOR,
		maxUnits: config.max ?? Number.POSITIVE_INFINITY,
	};
}

export function deviceCost(platform: Platform, config: CapacityConfig): Cost {
	return { ...DEFAULT_COSTS[platform], ...config.cost?.[platform] };
}

export const addCost = (a: Cost, b: Cost): Cost => ({ memMb: a.memMb + b.memMb, cpu: a.cpu + b.cpu });

/** Summed cost of booting these devices. */
export function totalCost(platforms: readonly Platform[], config: CapacityConfig): Cost {
	return platforms.reduce((sum, platform) => addCost(sum, deviceCost(platform, config)), ZERO_COST);
}

/** Does `usage + request` stay inside `budget`? When not, `binding` is the dimension over by the largest share. */
export function fits(usage: Cost, request: Cost, budget: Budget): FitResult {
	const total = addCost(usage, request);
	const dims: { dim: Dimension; used: number; limit: number }[] = [
		{ dim: "cpu", used: total.cpu, limit: budget.cpu },
		{ dim: "mem", used: total.memMb, limit: budget.memMb },
		{ dim: "max", used: total.cpu, limit: budget.maxUnits },
	];
	const over = dims.filter((d) => d.used > d.limit + EPSILON);
	const worst = over.sort((a, b) => b.used / b.limit - a.used / a.limit)[0];
	if (worst === undefined) {
		return {
			fits: true,
			remaining: {
				memMb: budget.memMb - total.memMb,
				cpu: Math.min(budget.cpu, budget.maxUnits) - total.cpu,
			},
		};
	}
	return { fits: false, binding: worst.dim, need: worst.used, available: worst.limit };
}

/** How many devices of `platform` fit on an otherwise empty host. */
export function maxConcurrent(platform: Platform, budget: Budget, config: CapacityConfig): number {
	const cost = deviceCost(platform, config);
	const limits = [budget.memMb / cost.memMb, Math.min(budget.cpu, budget.maxUnits) / cost.cpu];
	return Math.max(0, Math.floor(Math.min(...limits) + EPSILON));
}

const DIMENSION_LABEL: Record<Dimension, string> = { mem: "memory (MB)", cpu: "cpu (units)", max: "max (units)" };

/** One line for `warden capacity` and the queue progress log. */
export function explain(result: FitResult, usage: Cost, budget: Budget): string {
	const cpuLimit = Math.min(budget.cpu, budget.maxUnits);
	const state = `using ${usage.cpu.toFixed(1)}/${cpuLimit.toFixed(1)} cpu units, ${Math.round(usage.memMb)}/${Math.round(budget.memMb)} MB`;
	if (result.fits) return `fits: ${state}`;
	const label = DIMENSION_LABEL[result.binding];
	const fmt = (n: number) => (result.binding === "mem" ? String(Math.round(n)) : n.toFixed(1));
	return `no room, ${result.binding} binds: need ${fmt(result.need)} of ${fmt(result.available)} ${label}; ${state}`;
}
