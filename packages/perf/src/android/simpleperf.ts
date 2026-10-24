import type { Finding } from "../shared/findings.types";
import { HOTSPOT_CRITICAL_PCT, HOTSPOT_WARN_PCT } from "./analyze";

export type SimpleperfRow = { percent: number; command: string; dso: string; symbol: string };
export type SimpleperfReport = { samples: number; rows: SimpleperfRow[] };

const ROW = /^\s*(\d+(?:\.\d+)?)%\s+(\S+)\s+(\S+)\s+(.+?)\s*$/;

/**
 * `simpleperf report --stdio --sort comm,dso,symbol`: `Samples: N` in the header, then a table under
 * `Overhead  Command  Shared Object  Symbol` with one `NN.NN%  comm  dso  symbol` row per line.
 * Rows come back in the order printed (highest overhead first). Tolerant of header lines it does not know.
 */
export function parseSimpleperfReport(text: string): SimpleperfReport {
	let samples = 0;
	let inTable = false;
	const rows: SimpleperfRow[] = [];
	for (const line of text.split("\n")) {
		const s = /^Samples:\s*(\d+)/.exec(line);
		if (s?.[1] !== undefined) samples = Number(s[1]);
		if (/^\s*Overhead\s+Command\b/.test(line)) {
			inTable = true;
			continue;
		}
		if (!inTable) continue;
		const m = ROW.exec(line);
		if (m?.[1] && m[2] && m[3] && m[4]) {
			rows.push({ percent: Number(m[1]), command: m[2], dso: m[3], symbol: m[4] });
		}
	}
	return { samples, rows };
}

/** Same thresholds as the Perfetto path: critical over 15% of samples, warn from 3%. */
export function simpleperfFindings(report: SimpleperfReport, hz: number): Finding[] {
	return report.rows
		.filter((r) => r.percent >= HOTSPOT_WARN_PCT)
		.map((r) => ({
			kind: "native-hotspot" as const,
			severity: r.percent > HOTSPOT_CRITICAL_PCT ? ("critical" as const) : ("warn" as const),
			costMs: (report.samples * r.percent * 10) / hz,
			thread: r.command,
			function: r.symbol,
			selfPct: r.percent,
			evidence: `${r.symbol} (${r.dso.split("/").pop()}) is ${r.percent.toFixed(1)}% of the app's CPU samples on ${r.command}`,
			fix: "reduce work in this function or move it off that thread; verify with perf record --native=simpleperf after the change",
			next: ["warden perf native --native=simpleperf"],
		}));
}
