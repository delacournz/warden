import type { DiskGateDeps } from "@delacour/warden-core/claim";
import {
	type DiskConfig,
	type DiskFacts,
	type DiskVerdict,
	judgeDisk,
	readDiskFacts,
} from "@delacour/warden-core/disk";
import { currentOs, type HostOs } from "@delacour/warden-core/host";
import { ok } from "@delacour/warden-types/result";
import type { CommandContext } from "./context";

/** `WARDEN_DISK=off` (or 0 / false / no) turns the disk gate off. */
export function diskGateEnabled(env: Record<string, string | undefined>): boolean {
	const value = env.WARDEN_DISK?.trim().toLowerCase();
	return !(value === "off" || value === "0" || value === "false" || value === "no");
}

/**
 * Disk thresholds from env: `WARDEN_DISK_FLOOR_GB`, `WARDEN_DISK_CRITICAL_GB` (> 0) and `WARDEN_DISK_SWAP_WARN_GB` (>= 0).
 * A bad value is skipped and reported in `problems`.
 */
export function diskConfigFromEnv(env: Record<string, string | undefined>): {
	config: DiskConfig;
	problems: string[];
} {
	const config: DiskConfig = {};
	const problems: string[] = [];
	const read = (name: string, min: number, strict: boolean): number | undefined => {
		const raw = env[name];
		if (raw === undefined || raw.trim() === "") return undefined;
		const n = Number(raw);
		if (!Number.isFinite(n) || (strict ? n <= min : n < min)) {
			problems.push(`${name}=${raw} must be a number ${strict ? ">" : ">="} ${min} — ignored`);
			return undefined;
		}
		return n;
	};
	const floor = read("WARDEN_DISK_FLOOR_GB", 0, true);
	if (floor !== undefined) config.floorGb = floor;
	const critical = read("WARDEN_DISK_CRITICAL_GB", 0, true);
	if (critical !== undefined) config.criticalGb = critical;
	const swap = read("WARDEN_DISK_SWAP_WARN_GB", 0, false);
	if (swap !== undefined) config.swapWarnGb = swap;
	return { config, problems };
}

/** Facts of the boot volume and the verdict on them, read with the context's `exec` (no real probes in tests). */
export async function readDiskState(
	ctx: CommandContext,
	os: HostOs = currentOs()
): Promise<{ facts: DiskFacts; verdict: DiskVerdict }> {
	const facts = await readDiskFacts(ctx.exec, { os, home: ctx.env.HOME ?? "", now: ctx.now() });
	return { facts, verdict: judgeDisk(facts, diskConfigFromEnv(ctx.env).config) };
}

/** A queued claim polls every couple of seconds: reuse a verdict this fresh. */
export const DISK_GATE_CACHE_MS = 15_000;

/** The claim's disk gate; undefined when `WARDEN_DISK=off`. The verdict is cached for `DISK_GATE_CACHE_MS`. */
export function buildDiskGate(ctx: CommandContext, os?: HostOs): DiskGateDeps | undefined {
	if (!diskGateEnabled(ctx.env)) return undefined;
	let cached: { at: number; verdict: DiskVerdict } | undefined;
	return {
		verdict: async () => {
			const now = ctx.now();
			if (cached && now - cached.at < DISK_GATE_CACHE_MS) return ok(cached.verdict);
			const { verdict } = await readDiskState(ctx, os);
			cached = { at: now, verdict };
			return ok(verdict);
		},
	};
}
