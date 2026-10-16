/** Shared number formatters for the markdown / HTML reports. NaN, Infinity and undefined render as an em dash. */
export const DASH = "—";

const finite = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n);

/** Milliseconds as `850 ms` below one second, else `1.23 s`. */
export function ms(n: number | undefined): string {
	if (!finite(n)) return DASH;
	if (Math.abs(n) < 1000) return `${Math.round(n)} ms`;
	return `${(n / 1000).toFixed(2)} s`;
}

/** Signed milliseconds for deltas: `+1.20 s`, `-150 ms`, `0 ms`. */
export function signedMs(n: number | undefined): string {
	if (!finite(n)) return DASH;
	const text = ms(Math.abs(n));
	if (Math.round(n) === 0) return "0 ms";
	return `${n > 0 ? "+" : "-"}${text}`;
}

/** A 0..1 fraction as a whole-number-ish percent: `0.975` → `97.5%`, `1` → `100%`. */
export function pct(fraction: number | undefined): string {
	if (!finite(fraction)) return DASH;
	return `${Number((fraction * 100).toFixed(1))}%`;
}

/** Signed percent from a value already in percent units: `10` → `+10.0%`. */
export function signedPct(percent: number | undefined): string {
	if (!finite(percent)) return DASH;
	return `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

/** Bytes in 1024 steps as `12.3 MB`. */
export function bytes(n: number | undefined): string {
	if (!finite(n)) return DASH;
	const units = ["B", "KB", "MB", "GB", "TB"] as const;
	let value = Math.abs(n);
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
	return `${n < 0 ? "-" : ""}${text} ${units[unit]}`;
}

/** A ratio as `1.52×`. */
export function ratio(n: number | undefined): string {
	if (!finite(n)) return DASH;
	return `${n.toFixed(2)}×`;
}
