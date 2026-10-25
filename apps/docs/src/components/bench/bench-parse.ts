import type { BenchSummary } from "@delacour/warden-e2e-bench/src/report/summary";

/** Summary versions the page renders. 1 has no CPU-seconds or per-process rows; 2 adds them (all optional). */
export const SUPPORTED_VERSIONS: readonly number[] = [1, 2];

/** Narrow a parsed JSON file to a summary of a supported version. */
export const isSummary = (value: unknown): value is BenchSummary =>
	typeof value === "object" &&
	value !== null &&
	"summaryVersion" in value &&
	typeof value.summaryVersion === "number" &&
	SUPPORTED_VERSIONS.includes(value.summaryVersion) &&
	"frameworks" in value &&
	Array.isArray(value.frameworks);
