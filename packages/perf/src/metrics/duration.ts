const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000 };

/** `500ms` / `1.5s` / `2m` / a bare number (seconds) to milliseconds; undefined for anything else or a non-positive value. */
export function parseDuration(text: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(text.trim());
	if (m === null) return undefined;
	const ms = Math.round(Number(m[1]) * (UNIT_MS[m[2] ?? "s"] ?? 1000));
	return ms > 0 ? ms : undefined;
}
