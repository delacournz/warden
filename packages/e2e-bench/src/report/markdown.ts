import type { Manifest } from "../results/manifest";
import {
	type BenchRun,
	type FrameworkResult,
	HOST_GROUPS,
	type OkFrameworkResult,
	type Series,
} from "../results/schema";
import { bytes, cpuSeconds, DASH, ms, pct, ratio, signedMs } from "./format";
import {
	cpuSecondsPerRep,
	type PerTestMatrix,
	perTestMatrix,
	type SummaryRow,
	summaryRows,
	untracedRows,
} from "./tables";

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
	"Android `sim` counts the app and every framework's on-device helpers (uiautomator, instrumentation runners, Maestro, agent-device, Argent, warden-uiad), matched case-insensitively",
	"Host processes are tracked by pid and start time, so a reused pid is never counted",
	"Android animation scales are reset to the device's original values before every framework and restored at the end",
];

/** Escapes a value for a GFM table cell. */
const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

/** Marks a number from a framework that failed some test: `8738 ✗ (0.53×)` in matrices. */
const flag = (text: string, failing: boolean, ratioValue?: number): string => {
	if (!failing || text === DASH) return text;
	if (ratioValue === undefined) return `${text} ✗`;
	const suffix = ` (${ratio(ratioValue)})`;
	return text.endsWith(suffix) ? `${text.slice(0, -suffix.length)} ✗${suffix}` : `${text} ✗`;
};

/** A negative cold-start cost means rep 1 was not slower. */
const coldStart = (n: number | undefined): string =>
	n !== undefined && Number.isFinite(n) && n < 0 ? `none (rep 1 not slower, ${signedMs(n)})` : ms(n);

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
		flag(bold(ms(r.suiteMedianMs), r.fastest), r.failing),
		ms(r.suiteP95Ms),
		ratio(r.ratio),
		ms(r.coldRep1Ms),
		coldStart(r.coldStartMs),
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
			return flag(bold(text, c.fastest), c.failing, c.ratio);
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

function untracedSection(run: BenchRun): string[] {
	const rows = untracedRows(run).map((r) => [
		r.framework,
		ms(r.perRepMs),
		pct(r.share),
		r.worst === undefined ? DASH : `${r.worst.id} (${ms(r.worst.ms)})`,
	]);
	if (rows.length === 0) return [];
	return [
		"## Untraced time",
		"",
		...table(["Framework", "Untraced / rep", "Share of test time", "Largest (test)"], rows),
		"",
		"Test wall time that no step and no span of the framework's own trace covers (warden: `trace.jsonl`; nested " +
			"steps and spans count once). Runner overhead, hooks, sleeps and calls nobody wrapped end up here.",
	];
}

const seriesCols = (s: Series): string[] => [
	`${s.cpuAvgPct.toFixed(1)}%`,
	`${s.cpuPeakPct.toFixed(1)}%`,
	bytes(s.rssAvgBytes),
	bytes(s.rssPeakBytes),
];

const RESOURCES_NOTE =
	"Sampled every 500 ms from `ps`. `host` = the framework's own process tree; `sim` = every process of the " +
	"simulator's `launchd_sim` tree, or on Android the app under test plus every framework's on-device helpers " +
	"from `top` (every 2 s). RSS is a per-process sum, so shared framework " +
	"pages are counted once per process: compare the numbers across frameworks, not against physical memory.";

const CPU_NOTE =
	"`CPU-s / rep` (the CPU headline) is the CPU time of the timed run only, median over the warm reps, from " +
	"per-process deltas of `ps time`; the other columns are whole-framework (prepare, every rep, the per-rep " +
	"housekeeping and teardown), so their averages move with suite length. `CPU avg` / `CPU peak` are `ps %cpu`, a " +
	"decaying average on macOS, kept for comparison with older runs. Android `sim` has no CPU-seconds (`top` only).";

/** The host split by process group (whole-framework), for runs that recorded it. */
function groupSection(oks: readonly OkFrameworkResult[]): string[] {
	const rows = oks.flatMap((f) =>
		HOST_GROUPS.flatMap((g) => {
			const s = f.resources.host.byGroup?.[g];
			return s === undefined
				? []
				: [[f.framework, g, cpuSeconds(s.cpuSeconds), bytes(s.rssAvgBytes), bytes(s.rssPeakBytes)]];
		})
	);
	if (rows.length === 0) return [];
	return [
		"",
		"### Host by process group",
		"",
		...table(["Framework", "Group", "CPU-s (whole)", "RSS avg", "RSS peak"], rows),
		"",
		"`bun-test` the spec process, `warden-simd` the resident iOS helper, `warden-cli` the `warden` commands the " +
			"bench spawned, `adb` / `emulator` the Android tools, `other` the rest (another framework's runner, " +
			"`xcrun`, java). Each group's RSS average counts 0 for ticks without a process, so the groups add up to the host.",
	];
}

function resourcesSection(run: BenchRun): string[] {
	const oks = run.frameworks.filter(isOk);
	const withCpu = oks.some((f) => cpuSecondsPerRep(f) !== undefined || f.resources.host.cpuSeconds !== undefined);
	if (!withCpu) {
		const headers = ["Framework", "Scope", "CPU avg", "CPU peak", "RSS avg", "RSS peak"];
		const rows = oks.flatMap((f) => [
			[f.framework, "host", ...seriesCols(f.resources.host)],
			[f.framework, "sim", ...seriesCols(f.resources.sim)],
		]);
		return ["## Resources", "", ...table(headers, rows), "", RESOURCES_NOTE];
	}
	const headers = ["Framework", "Scope", "CPU-s / rep", "CPU-s (whole)", "CPU avg", "CPU peak", "RSS avg", "RSS peak"];
	const rows = oks.flatMap((f) => [
		[
			f.framework,
			"host",
			cpuSeconds(cpuSecondsPerRep(f)),
			cpuSeconds(f.resources.host.cpuSeconds),
			...seriesCols(f.resources.host),
		],
		[f.framework, "sim", DASH, cpuSeconds(f.resources.sim.cpuSeconds), ...seriesCols(f.resources.sim)],
	]);
	return ["## Resources", "", ...table(headers, rows), "", RESOURCES_NOTE, "", CPU_NOTE, ...groupSection(oks)];
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
		untracedSection(run),
		resourcesSection(run),
		residueSection(run),
		problemSection(run),
		["---", "", `Generated by @delacour/warden-e2e-bench schema v${run.schemaVersion}, run \`${run.id}\`.`],
	];
	return `${sections
		.filter((s) => s.length > 0)
		.map((s) => s.join("\n"))
		.join("\n\n")}\n`;
}
