const BARS = "▁▂▃▄▅▆▇█";

/** `zero` scales from 0 (cpu, fps: a quiet app should look quiet), `min` from the series minimum (memory: otherwise a 1% drift fills the line). */
export type SparkFloor = "zero" | "min";

/**
 * The last `width` values as a unicode sparkline, padded with spaces to `width` so the columns after it stay
 * put. A flat series is all the lowest bar.
 */
export function sparkline(values: readonly number[], width: number, floor: SparkFloor = "zero"): string {
	const shown = values.slice(-width);
	if (shown.length === 0) return " ".repeat(width);
	const max = Math.max(...shown);
	const lo = floor === "zero" ? 0 : Math.min(...shown);
	const span = max - lo;
	const line = shown
		.map((v) => {
			if (span <= 0) return BARS[0];
			const level = Math.round(((v - lo) / span) * (BARS.length - 1));
			return BARS[Math.min(BARS.length - 1, Math.max(0, level))];
		})
		.join("");
	return line.padEnd(width, " ");
}

export type SparkUnit = "%" | "MB" | "fps";

export type WatchRow = { label: string; unit: SparkUnit; floor: SparkFloor; values: readonly number[] };

export type WatchFrame = { title: string; elapsedMs: number; rows: readonly WatchRow[] };

const fmt = (v: number, unit: SparkUnit): string =>
	`${v.toFixed(unit === "MB" ? 0 : 1)}${unit === "MB" ? " MB" : unit === "fps" ? " fps" : "%"}`;

/** Width left for the sparkline once the label and the three figures are laid out (`cur … avg … max …`). */
export function sparkWidth(columns: number): number {
	return Math.min(60, Math.max(10, columns - 52));
}

/**
 * One redraw of `perf metrics --watch`: a title line and a row per series (`cpu ▁▂▃ cur 12.4%  avg 8.1%  max 31.0%`).
 * Pure: `dim` is the colouring hook, so tests and non-colour terminals pass identity.
 */
export function renderWatch(frame: WatchFrame, columns: number, dim: (text: string) => string = (s) => s): string[] {
	const width = sparkWidth(columns);
	const labelWidth = Math.max(0, ...frame.rows.map((r) => r.label.length));
	const lines = [`${frame.title}  ${dim(`+${(frame.elapsedMs / 1000).toFixed(0)}s  ctrl-c to stop`)}`];
	for (const row of frame.rows) {
		const last = row.values[row.values.length - 1];
		if (last === undefined) {
			lines.push(`${row.label.padEnd(labelWidth)}  ${" ".repeat(width)}  ${dim("waiting")}`);
			continue;
		}
		const avg = row.values.reduce((a, b) => a + b, 0) / row.values.length;
		const max = Math.max(...row.values);
		lines.push(
			`${row.label.padEnd(labelWidth)}  ${sparkline(row.values, width, row.floor)}  cur ${fmt(last, row.unit)}  ${dim(`avg ${fmt(avg, row.unit)}  max ${fmt(max, row.unit)}`)}`
		);
	}
	return lines;
}

/** ANSI to erase `lines` previously drawn lines and put the cursor back at the top of them. */
export const eraseLines = (lines: number): string => (lines > 0 ? `\x1b[${lines}A\x1b[J` : "");
