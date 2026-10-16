import type { Manifest } from "../results/manifest";
import type { BenchRun, FrameworkResult, OkFrameworkResult, Series } from "../results/schema";
import { bytes, DASH, ms, pct, ratio } from "./format";
import { type PerTestMatrix, perTestMatrix, type SummaryRow, summaryRows } from "./tables";

/** The fairness rules, as recorded in every report header (see docs/plans/wdn-bench.md). */
export const FAIRNESS_RULES: readonly string[] = [
	"Same `.app` for every framework (sha256 recorded above)",
	"Zero LLM calls",
	"Same assertions per canonical test id",
	"Same retry helpers (dropped first tap, dropped deep link, system alerts)",
	"Fresh app launch per test",
	"`retries=0`",
	"Frameworks run sequentially",
	"`caffeinate -dims` held for the run",
	"Warm medians exclude rep 1 (cold)",
	"Machine-readable reporters only",
	"Host otherwise idle; load average recorded",
];

/** Escapes a value for a GFM table cell. */
const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

const bold = (text: string, on: boolean): string => (on && text !== DASH ? `**${text}**` : text);

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
	const line = (cols: readonly string[]) => `| ${cols.map(cell).join(" | ")} |`;
	return [line(headers), line(headers.map(() => "---")), ...rows.map(line)];
}

const isOk = (f: FrameworkResult): f is OkFrameworkResult => f.status === "ok";

const optional = (value: string | undefined): string => value ?? DASH;

function headerBlock(run: BenchRun): string[] {
	const { host, device, app, options } = run;
	const versions = run.frameworks.map((f) => `${f.framework} ${("version" in f && f.version) || DASH}`).join(", ");
	return [
		`- **Host:** ${host.model}, ${host.cpu}, ${host.cores} cores, ${bytes(host.memBytes)} RAM, macOS ${host.macos}`,
		`- **Toolchain:** Xcode ${optional(host.xcode)}, Java ${optional(host.java)}, Node ${optional(host.node)}, bun ${host.bun}, warden ${host.warden}`,
		`- **Host load at start:** ${host.loadAvgAtStart.toFixed(2)}`,
		`- **Device:** ${device.name ?? DASH} (${device.platform}, ${optional(device.runtime)}), udid \`${device.udid}\``,
		`- **App:** \`${app.bundleId}\`, hash \`${app.hash}\`, sha256 \`${app.sha256.slice(0, 12)}\`, ${bytes(app.bytes)}`,
		`- **Options:** runs ${options.runs}, retries ${options.retries}, reboot between ${options.rebootBetween ? "yes" : "no"}, caffeinated ${options.caffeinated ? "yes" : "no"}`,
		`- **Frameworks:** ${versions}`,
	];
}

function residueCell(r: SummaryRow): string {
	if (!r.residue) return DASH;
	const { processes, driverApps, paths } = r.residue;
	return `${processes} proc / ${driverApps} app / ${paths} path`;
}

function footprintCell(r: SummaryRow): string {
	return r.footprint ? `${r.footprint.loc} LOC / ${bytes(r.footprint.depsBytes)}` : DASH;
}

function summarySection(run: BenchRun): string[] {
	const headers = [
		"Framework",
		"Status",
		"Version",
		"Suite median (warm)",
		"p95",
		"Ratio",
		"Cold rep 1",
		"Cold-start cost",
		"Prepare",
		"Teardown",
		"Overhead",
		"Pass rate",
		"Flake",
		"Residue",
		"Footprint (LOC / deps)",
	];
	const rows = summaryRows(run).map((r) => [
		r.framework,
		r.status,
		optional(r.version),
		bold(ms(r.suiteMedianMs), r.fastest),
		ms(r.suiteP95Ms),
		ratio(r.ratio),
		ms(r.coldRep1Ms),
		ms(r.coldStartMs),
		ms(r.prepareMs),
		ms(r.teardownMs),
		ms(r.overheadMs),
		pct(r.passRate),
		pct(r.flakeRate),
		residueCell(r),
		footprintCell(r),
	]);
	return ["## Summary", "", ...table(headers, rows)];
}

function matrixSection(matrix: PerTestMatrix): string[] {
	const headers = ["Test", ...matrix.frameworks];
	const rows = matrix.rows.map((row) => [
		row.title,
		...matrix.frameworks.map((fw) => {
			const c = row.cells[fw];
			if (!c) return DASH;
			const text = `${Math.round(c.medianMs)}${c.ratio !== undefined ? ` (${ratio(c.ratio)})` : ""}`;
			return bold(text, c.fastest);
		}),
	]);
	return ["## Per-test medians (ms)", "", ...table(headers, rows)];
}

function stepSection(run: BenchRun): string[] {
	const rows = run.frameworks.filter(isOk).flatMap((f) => {
		const d = f.stats.stepLatency;
		return d ? [[f.framework, String(d.n), ms(d.median), ms(d.p95), ms(d.max)]] : [];
	});
	if (rows.length === 0) return ["## Per-step latency", "", "No framework reported steps."];
	return ["## Per-step latency", "", ...table(["Framework", "Steps", "Median", "p95", "Max"], rows)];
}

const seriesCols = (s: Series): string[] => [
	`${s.cpuAvgPct.toFixed(1)}%`,
	`${s.cpuPeakPct.toFixed(1)}%`,
	bytes(s.rssAvgBytes),
	bytes(s.rssPeakBytes),
];

function resourcesSection(run: BenchRun): string[] {
	const headers = ["Framework", "Scope", "CPU avg", "CPU peak", "RSS avg", "RSS peak"];
	const rows = run.frameworks.filter(isOk).flatMap((f) => [
		[f.framework, "host", ...seriesCols(f.resources.host)],
		[f.framework, "sim", ...seriesCols(f.resources.sim)],
	]);
	return [
		"## Resources",
		"",
		...table(headers, rows),
		"",
		"Sampled every 500 ms from `ps`. `host` = the framework's own process tree; `sim` = every process of the device " +
			"(the simulator's `launchd_sim` tree, or the emulator's `top`). RSS is a per-process sum, so shared framework " +
			"pages are counted once per process: compare the numbers across frameworks, not against physical memory.",
	];
}

function residueSection(run: BenchRun): string[] {
	const out = ["## Residue", ""];
	for (const f of run.frameworks.filter(isOk)) {
		const r = f.residue;
		const parts = [
			...(r.processes.length > 0 ? [`processes: ${r.processes.join(", ")}`] : []),
			...(r.driverApps.length > 0 ? [`driver apps: ${r.driverApps.join(", ")}`] : []),
			...(r.paths.length > 0 ? [`paths: ${r.paths.map((p) => `${p.path} (${bytes(p.deltaBytes)})`).join(", ")}`] : []),
		];
		out.push(`- **${f.framework}:** ${parts.length > 0 ? parts.join("; ") : "none"}`);
	}
	return out;
}

function problemSection(run: BenchRun): string[] {
	const bad = run.frameworks.filter((f) => !isOk(f));
	if (bad.length === 0) return ["## Unsupported / failed", "", "None."];
	const lines = bad.map((f) => {
		if (f.status === "unsupported") return `- **${f.framework}:** unsupported. ${f.reason}`;
		if (f.status === "failed") return `- **${f.framework}:** failed in phase \`${f.phase}\`. ${f.error}`;
		return "";
	});
	return ["## Unsupported / failed", "", ...lines];
}

/** The whole report as markdown. Pure: the same run and manifest always yield the same text. */
export function renderMarkdown(run: BenchRun, manifest: Manifest): string {
	const sections = [
		[`# e2e framework benchmark — ${run.device.platform} ${run.startedAt.slice(0, 10)}`],
		headerBlock(run),
		["## Fairness rules", "", ...FAIRNESS_RULES.map((r) => `- ${r}`)],
		summarySection(run),
		matrixSection(perTestMatrix(run, manifest)),
		stepSection(run),
		resourcesSection(run),
		residueSection(run),
		problemSection(run),
		["---", "", `Generated by @delacour/warden-e2e-bench schema v${run.schemaVersion}, run \`${run.id}\`.`],
	];
	return `${sections.map((s) => s.join("\n")).join("\n\n")}\n`;
}
