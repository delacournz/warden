import type { Result } from "@delacour/warden-types/result";

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `10m` / `30s` / `2h` / `500ms` / bare seconds → milliseconds. */
export function parseDuration(input: string): Result<number> {
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(input.trim());
	if (!match?.[1]) return { success: false, error: `invalid duration "${input}" (use e.g. 30s, 10m, 2h)` };
	return { success: true, data: Math.round(Number(match[1]) * (UNIT_MS[match[2] ?? "s"] ?? 1_000)) };
}

/** 125000 → `2m5s`. */
export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1_000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ""}`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
}
