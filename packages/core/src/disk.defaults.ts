/** Disk thresholds: free space below the floor warns, below critical refuses new boots; swap above swapWarnGb warns. */
export const DISK_DEFAULTS = {
	floorGb: 20,
	floorShare: 0.1,
	criticalGb: 8,
	criticalShare: 0.04,
	swapWarnGb: 8,
	uptimeWarnDays: 7,
} as const;
