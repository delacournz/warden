import type { DiskConfig } from "@delacour/warden-core/disk";

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
