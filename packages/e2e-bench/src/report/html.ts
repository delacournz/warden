import type { Manifest } from "../results/manifest";
import type { BenchRun, FrameworkResult, OkFrameworkResult, Series } from "../results/schema";
import { escapeHtml } from "./escape";
import { bytes, DASH, ms, pct, ratio, signedMs } from "./format";
import { FAIRNESS_RULES } from "./markdown";
import { type BarGroup, type BoxGroup, barChart, boxChart, tickMs } from "./svg";
import { type PerTestMatrix, perTestMatrix, type SummaryRow, summaryRows } from "./tables";

type FrameworkKey = FrameworkResult["framework"];

/** Fixed categorical slot per framework: colour follows the entity, never its rank or the filter state. */
const SLOT: Record<FrameworkKey, number> = {
	warden: 1,
	maestro: 2,
	argent: 3,
	"agent-device": 4,
	"tester-army": 5,
	detox: 6,
};

/** Validated reference palette (dataviz skill), slots 1-6: [light, dark]. */
const SERIES_COLORS: readonly (readonly [string, string])[] = [
	["#2a78d6", "#3987e5"],
	["#eb6834", "#d95926"],
	["#1baf7a", "#199e70"],
	["#eda100", "#c98500"],
	["#e87ba4", "#d55181"],
	["#008300", "#008300"],
];

const LIGHT_TOKENS = [
	"--surface:#fcfcfb",
	"--surface-2:#f4f3ef",
	"--text:#0b0b0b",
	"--text-2:#52514e",
	"--grid:#e1e0d9",
	"--border:rgba(11,11,11,0.10)",
];
const DARK_TOKENS = [
	"--surface:#1a1a19",
	"--surface-2:#232321",
	"--text:#f0efec",
	"--text-2:#c3c2b7",
	"--grid:#2c2c2a",
	"--border:rgba(255,255,255,0.10)",
];

const seriesTokens = (mode: 0 | 1): string[] => SERIES_COLORS.map((c, i) => `--series-${i + 1}:${c[mode]}`);

const FRAMEWORKS = Object.keys(SLOT) as FrameworkKey[];

const isOk = (f: FrameworkResult): f is OkFrameworkResult => f.status === "ok";

const fwClass = (fw: string): string => `s-${fw.replace(/[^a-z0-9-]/gi, "")}`;

/** The page stylesheet. Tokens live on `:root`; dark mode is selected by media query and by `data-theme`. */
function css(): string {
	const light = [...LIGHT_TOKENS, ...seriesTokens(0), "color-scheme:light"].join(";");
	const dark = [...DARK_TOKENS, ...seriesTokens(1), "color-scheme:dark"].join(";");
	const slots = FRAMEWORKS.map((fw) => `.${fwClass(fw)}{--c:var(--series-${SLOT[fw]})}`).join("");
	return `
:root{${light}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}
:root[data-theme="dark"]{${dark}}
${slots}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 4px}
h2{font-size:1.2rem;margin:40px 0 12px;padding-top:16px;border-top:1px solid var(--grid)}
h3{font-size:1rem;margin:24px 0 8px}
.sub{color:var(--text-2);margin:0 0 16px}
code{font:0.9em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface-2);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:16px 0;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:12px 16px}
dl.meta dt{color:var(--text-2)}
dl.meta dd{margin:0;overflow-wrap:anywhere}
.table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:8px;margin:12px 0}
table{border-collapse:collapse;width:100%;font-size:0.9rem}
th,td{padding:6px 10px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--grid)}
th:first-child,td:first-child{text-align:left;background:var(--surface);white-space:normal;min-width:140px;max-width:240px}
th{color:var(--text-2);font-weight:600;background:var(--surface-2)}
th:first-child{background:var(--surface-2)}
td{font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
td.t{text-align:left}
.legend{display:flex;flex-wrap:wrap;gap:4px 16px;list-style:none;margin:8px 0;padding:0;font-size:0.9rem}
.legend li{color:var(--text-2);display:flex;align-items:center;gap:6px}
.sw{width:12px;height:12px;border-radius:3px;background:var(--c);display:inline-block}
.note{color:var(--text-2);font-size:0.85rem;margin:4px 0 8px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px;margin:8px 0}
svg.chart{width:100%;max-width:680px;height:auto;display:block;overflow:visible}
.chart text{font:14px system-ui,-apple-system,"Segoe UI",sans-serif;fill:var(--text-2)}
.chart text.group{fill:var(--text);font-weight:600}
.chart text.val{fill:var(--text)}
.chart text.best{font-weight:700}
.chart .grid{stroke:var(--grid);stroke-width:1}
.chart .mark{fill:var(--c)}
.chart .box{fill:var(--c);fill-opacity:.35;stroke:var(--c);stroke-width:1}
.chart .whisker{stroke:var(--text-2);stroke-width:1.5}
.chart .median{stroke:var(--text);stroke-width:2.5}
.chart .marker{fill:var(--text);stroke:var(--surface);stroke-width:2}
.status{font-weight:600}
.toggle{display:flex;flex-wrap:wrap;gap:4px 16px;margin:12px 0;font-size:0.9rem}
.toggle[hidden]{display:none}
.toggle label{display:flex;align-items:center;gap:6px;min-height:28px}
.off{display:none}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--grid);color:var(--text-2);font-size:0.85rem}
ul.plain{padding-left:20px}
@media (min-width:700px){th:first-child,td:first-child{position:sticky;left:0}}
@media (max-width:520px){dl.meta{grid-template-columns:1fr}dl.meta dt{margin-top:6px}}
`;
}

/** Escapes text, then turns `backtick` spans into <code>. */
function inlineCode(text: string): string {
	return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

const optional = (value: string | undefined): string => escapeHtml(value ?? DASH);

function metaRow(label: string, valueHtml: string): string {
	return `<dt>${escapeHtml(label)}</dt><dd>${valueHtml}</dd>`;
}

function headerSection(run: BenchRun): string {
	const { host, device, app, options } = run;
	const versions = run.frameworks
		.map((f) => `${escapeHtml(f.framework)} ${escapeHtml(("version" in f && f.version) || DASH)}`)
		.join(", ");
	const rows = [
		metaRow(
			"Host",
			escapeHtml(`${host.model}, ${host.cpu}, ${host.cores} cores, ${bytes(host.memBytes)} RAM, macOS ${host.macos}`)
		),
		metaRow(
			"Toolchain",
			escapeHtml(
				`Xcode ${host.xcode ?? DASH}, Java ${host.java ?? DASH}, Node ${host.node ?? DASH}, bun ${host.bun}, warden ${host.warden}`
			)
		),
		metaRow("Host load at start", escapeHtml(host.loadAvgAtStart.toFixed(2))),
		metaRow(
			"Device",
			`${escapeHtml(device.name ?? DASH)} (${escapeHtml(device.platform)}, ${optional(device.runtime)}), udid <code>${escapeHtml(device.udid)}</code>`
		),
		metaRow(
			"App",
			`<code>${escapeHtml(app.bundleId)}</code>, hash <code>${escapeHtml(app.hash)}</code>, sha256 <code>${escapeHtml(app.sha256.slice(0, 12))}</code>, ${escapeHtml(bytes(app.bytes))}`
		),
		metaRow(
			"Options",
			escapeHtml(
				`runs ${options.runs}, retries ${options.retries}, reboot between ${options.rebootBetween ? "yes" : "no"}, caffeinated ${options.caffeinated ? "yes" : "no"}`
			)
		),
		metaRow("Frameworks", versions),
	];
	return `<dl class="meta">${rows.join("")}</dl>`;
}

function fairnessSection(): string {
	const items = FAIRNESS_RULES.map((r) => `<li>${inlineCode(r)}</li>`).join("");
	return `<section id="fairness"><h2>Fairness rules</h2><ul class="plain">${items}</ul></section>`;
}

type Td = { html: string; cls?: string; fw?: FrameworkKey };

const td = (html: string, extra: Partial<Td> = {}): Td => ({ html, ...extra });

function tr(cells: readonly Td[], fw?: FrameworkKey): string {
	const row = cells
		.map((c) => {
			const attrs = `${c.cls ? ` class="${c.cls}"` : ""}${c.fw ? ` data-fw="${c.fw}"` : ""}`;
			return `<td${attrs}>${c.html}</td>`;
		})
		.join("");
	return `<tr${fw ? ` data-fw="${fw}"` : ""}>${row}</tr>`;
}

function table(
	headers: readonly { text: string; fw?: FrameworkKey }[],
	rows: readonly string[],
	label: string
): string {
	const head = headers
		.map((h) => `<th scope="col"${h.fw ? ` data-fw="${h.fw}"` : ""}>${escapeHtml(h.text)}</th>`)
		.join("");
	return `<div class="table-wrap" role="region" aria-label="${escapeHtml(label)}" tabindex="0"><table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

const strong = (text: string, on: boolean): string =>
	on && text !== DASH ? `<strong>${escapeHtml(text)}</strong>` : escapeHtml(text);

const STATUS_ICON: Record<FrameworkResult["status"], string> = { ok: "✓", failed: "✕", unsupported: "–" };

function summaryRowHtml(r: SummaryRow): string {
	const residue = r.residue
		? `${r.residue.processes} proc / ${r.residue.driverApps} app / ${r.residue.paths} path`
		: DASH;
	const footprint = r.footprint ? `${r.footprint.loc} LOC / ${bytes(r.footprint.depsBytes)}` : DASH;
	const cells = [
		td(escapeHtml(r.framework)),
		td(`<span class="status">${STATUS_ICON[r.status]} ${escapeHtml(r.status)}</span>`),
		td(optional(r.version)),
		td(strong(ms(r.suiteMedianMs), r.fastest) + (r.failing ? " ✗" : "")),
		td(escapeHtml(ms(r.suiteP95Ms))),
		td(escapeHtml(ratio(r.ratio))),
		td(escapeHtml(ms(r.coldRep1Ms))),
		td(
			escapeHtml(
				r.coldStartMs !== undefined && r.coldStartMs < 0
					? `none (rep 1 not slower, ${signedMs(r.coldStartMs)})`
					: ms(r.coldStartMs)
			)
		),
		td(escapeHtml(ms(r.prepareMs))),
		td(escapeHtml(ms(r.teardownMs))),
		td(escapeHtml(ms(r.overheadMs))),
		td(escapeHtml(pct(r.passRate))),
		td(escapeHtml(pct(r.flakeRate))),
		td(escapeHtml(residue)),
		td(escapeHtml(footprint)),
	];
	return tr(cells, r.framework);
}

const SUMMARY_HEADERS = [
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
].map((text) => ({ text }));

/** Text summary of a chart for assistive tech. */
function describeGroups(groups: readonly { label: string; items: readonly string[] }[]): string {
	return groups
		.filter((g) => g.items.length > 0)
		.map((g) => `${g.label}: ${g.items.join(", ")}`)
		.join(". ");
}

function legend(run: BenchRun): string {
	const items = run.frameworks
		.map(
			(f) =>
				`<li data-fw="${f.framework}"><span class="sw ${fwClass(f.framework)}" aria-hidden="true"></span>${escapeHtml(f.framework)}</li>`
		)
		.join("");
	return `<ul class="legend" aria-label="Framework colours">${items}</ul>`;
}

function chartBlock(svg: string, empty: string): string {
	return svg === "" ? `<p class="note">${escapeHtml(empty)}</p>` : `<div class="card">${svg}</div>`;
}

type ChartOpts = { id: string; title: string; tickLabel: (v: number) => string };

/** A bar chart with an auto-built text description, or "" when no group has a bar. */
function barSafe(groups: readonly BarGroup[], meta: ChartOpts): string {
	if (groups.every((g) => g.bars.length === 0)) return "";
	const desc = describeGroups(
		groups.map((g) => ({ label: g.label, items: g.bars.map((b) => `${b.series} ${b.label}`) }))
	);
	return barChart({ ...meta, desc, groups });
}

/** A box chart with an auto-built text description, or "" when no group has a box. */
function boxSafe(groups: readonly BoxGroup[], meta: ChartOpts): string {
	if (groups.every((g) => g.boxes.length === 0)) return "";
	const desc = describeGroups(
		groups.map((g) => ({ label: g.label, items: g.boxes.map((b) => `${b.series} ${b.label}`) }))
	);
	return boxChart({ ...meta, desc, groups });
}

function suiteChart(run: BenchRun): string {
	const groups: BarGroup[] = run.frameworks.filter(isOk).map((f) => {
		const s = f.stats;
		return {
			label: `${f.framework} ${f.version}`,
			bars: [
				{
					series: f.framework,
					value: s.warmSuiteWall.median,
					whiskerTo: s.warmSuiteWall.p95,
					...(s.coldSuiteWallMs !== undefined ? { marker: s.coldSuiteWallMs } : {}),
					label: `${ms(s.warmSuiteWall.median)} · ${ratio(s.ratioToFastestSuite)}`,
					detail: `p95 ${ms(s.warmSuiteWall.p95)}, cold rep 1 ${ms(s.coldSuiteWallMs)}`,
					best: s.ratioToFastestSuite === 1,
				},
			],
		};
	});
	return barSafe(groups, {
		id: "c-suite",
		title: "Warm suite median per framework with p95 whisker and cold rep 1 marker",
		tickLabel: tickMs,
	});
}

function summarySection(run: BenchRun): string {
	const rows = summaryRows(run).map(summaryRowHtml);
	return [
		`<section id="summary"><h2>Summary</h2>`,
		table(SUMMARY_HEADERS, rows, "Summary table"),
		`<h3>Warm suite wall time</h3>`,
		legend(run),
		`<p class="note">Bar = warm median. Whisker = p95. Dot = cold rep 1. Lower is faster; ratios are against the fastest framework.</p>`,
		chartBlock(suiteChart(run), "No framework completed, so there is nothing to chart."),
		`</section>`,
	].join("");
}

function matrixCell(c: PerTestMatrix["rows"][number]["cells"][FrameworkKey], fw: FrameworkKey): Td {
	if (!c) return td(DASH, { fw });
	const mark = c.failing ? " ✗" : "";
	const text = `${Math.round(c.medianMs)}${mark}${c.ratio !== undefined ? ` (${ratio(c.ratio)})` : ""}`;
	return td(strong(text, c.fastest), { fw });
}

function matrixTable(matrix: PerTestMatrix): string {
	const headers = [{ text: "Test" }, ...matrix.frameworks.map((fw) => ({ text: fw, fw }))];
	const rows = matrix.rows.map((row) =>
		tr([td(escapeHtml(row.title)), ...matrix.frameworks.map((fw) => matrixCell(row.cells[fw], fw))])
	);
	return table(headers, rows, "Per-test medians in milliseconds");
}

function perTestBars(matrix: PerTestMatrix): string {
	const groups: BarGroup[] = matrix.rows.map((row) => ({
		label: row.title,
		bars: matrix.frameworks.flatMap((fw) => {
			const c = row.cells[fw];
			if (!c) return [];
			return [
				{
					series: fw,
					value: c.medianMs,
					label: `${Math.round(c.medianMs)} ms${c.ratio !== undefined ? ` · ${ratio(c.ratio)}` : ""}`,
					best: c.fastest,
				},
			];
		}),
	}));
	return barSafe(groups, {
		id: "c-tests",
		title: "Warm median per test and framework, in milliseconds",
		tickLabel: tickMs,
	});
}

function perTestBoxes(run: BenchRun, matrix: PerTestMatrix): string {
	const oks = run.frameworks.filter(isOk);
	const groups: BoxGroup[] = matrix.rows.map((row) => ({
		label: row.title,
		boxes: oks.flatMap((f) => {
			const d = f.stats.perTest[row.id];
			if (!d || d.n === 0) return [];
			return [
				{
					series: f.framework,
					min: d.min,
					median: d.median,
					p95: d.p95,
					max: d.max,
					label: `${f.framework} ${ms(d.median)}`,
					detail: `p95 ${ms(d.p95)}, min ${Math.round(d.min)}, max ${Math.round(d.max)}, n ${d.n}`,
				},
			];
		}),
	}));
	return boxSafe(groups, {
		id: "c-spread",
		title: "Warm rep spread per test: min to max whisker, min to p95 box, median tick",
		tickLabel: tickMs,
	});
}

function matrixSection(run: BenchRun, manifest: Manifest): string {
	const matrix = perTestMatrix(run, manifest);
	return [
		`<section id="tests"><h2>Per-test medians (ms)</h2>`,
		matrixTable(matrix),
		`<h3>Median per test</h3>`,
		legend(run),
		chartBlock(perTestBars(matrix), "No per-test data."),
		`<h3>Spread across warm reps</h3>`,
		`<p class="note">Whisker = min to max. Shaded box = min to p95. Tick = median. A distribution carries no quartiles, so the box is not an interquartile range.</p>`,
		chartBlock(perTestBoxes(run, matrix), "No per-test data."),
		`</section>`,
	].join("");
}

function stepsSection(run: BenchRun): string {
	const oks = run.frameworks.filter(isOk).filter((f) => f.stats.stepLatency !== undefined);
	if (oks.length === 0) {
		return `<section id="steps"><h2>Per-step latency</h2><p>No framework reported steps.</p></section>`;
	}
	const groups: BoxGroup[] = [];
	const rows: string[] = [];
	for (const f of oks) {
		const d = f.stats.stepLatency;
		if (!d) continue;
		groups.push({
			label: `${f.framework} (${d.n} steps)`,
			boxes: [
				{
					series: f.framework,
					min: d.min,
					median: d.median,
					p95: d.p95,
					max: d.max,
					label: `${ms(d.median)} · p95 ${ms(d.p95)}`,
				},
			],
		});
		rows.push(
			tr(
				[
					td(escapeHtml(f.framework)),
					td(String(d.n)),
					td(escapeHtml(ms(d.median))),
					td(escapeHtml(ms(d.p95))),
					td(escapeHtml(ms(d.max))),
				],
				f.framework
			)
		);
	}
	const headers = ["Framework", "Steps", "Median", "p95", "Max"].map((text) => ({ text }));
	return [
		`<section id="steps"><h2>Per-step latency</h2>`,
		legend(run),
		`<p class="note">Whisker = min to max. Shaded box = min to p95. Tick = median. Only frameworks that report steps appear.</p>`,
		chartBlock(
			boxSafe(groups, { id: "c-steps", title: "Step latency per framework", tickLabel: tickMs }),
			"No step data."
		),
		table(headers, rows, "Per-step latency table"),
		`</section>`,
	].join("");
}

const seriesRow = (f: OkFrameworkResult, scope: string, s: Series): string =>
	tr(
		[
			td(escapeHtml(f.framework)),
			td(escapeHtml(scope), { cls: "t" }),
			td(`${s.cpuAvgPct.toFixed(1)}%`),
			td(`${s.cpuPeakPct.toFixed(1)}%`),
			td(escapeHtml(bytes(s.rssAvgBytes))),
			td(escapeHtml(bytes(s.rssPeakBytes))),
		],
		f.framework
	);

type Metric = { label: string; pick: (f: OkFrameworkResult) => number };

function metricGroups(run: BenchRun, metrics: readonly Metric[], format: (n: number) => string): BarGroup[] {
	return metrics.map((m) => ({
		label: m.label,
		bars: run.frameworks.filter(isOk).map((f) => {
			const value = m.pick(f);
			return { series: f.framework, value, label: format(value) };
		}),
	}));
}

const cpuMetrics: readonly Metric[] = [
	{ label: "Host CPU average", pick: (f) => f.resources.host.cpuAvgPct },
	{ label: "Host CPU peak", pick: (f) => f.resources.host.cpuPeakPct },
	{ label: "Simulator CPU average", pick: (f) => f.resources.sim.cpuAvgPct },
	{ label: "Simulator CPU peak", pick: (f) => f.resources.sim.cpuPeakPct },
];
const rssMetrics: readonly Metric[] = [
	{ label: "Host RSS peak", pick: (f) => f.resources.host.rssPeakBytes },
	{ label: "Simulator RSS peak", pick: (f) => f.resources.sim.rssPeakBytes },
];

/** CPU (percent) and memory (bytes) are separate charts: two units never share one axis. */
function resourcesSection(run: BenchRun): string {
	const oks = run.frameworks.filter(isOk);
	const rows = oks.flatMap((f) => [seriesRow(f, "host", f.resources.host), seriesRow(f, "sim", f.resources.sim)]);
	const headers = ["Framework", "Scope", "CPU avg", "CPU peak", "RSS avg", "RSS peak"].map((text) => ({ text }));
	const cpu = barSafe(
		metricGroups(run, cpuMetrics, (n) => `${n.toFixed(1)}%`),
		{ id: "c-cpu", title: "CPU use per framework", tickLabel: (v) => `${v}%` }
	);
	const rss = barSafe(
		metricGroups(run, rssMetrics, (n) => bytes(n)),
		{ id: "c-rss", title: "Peak resident memory per framework", tickLabel: (v) => bytes(v) }
	);
	return [
		`<section id="resources"><h2>Resources</h2>`,
		legend(run),
		`<h3>CPU</h3>`,
		chartBlock(cpu, "No resource data."),
		`<h3>Memory</h3>`,
		chartBlock(rss, "No resource data."),
		table(headers, rows, "Resources table"),
		`</section>`,
	].join("");
}

function residueSection(run: BenchRun): string {
	const items = run.frameworks.filter(isOk).map((f) => {
		const r = f.residue;
		const parts = [
			...(r.processes.length > 0 ? [`processes: ${r.processes.join(", ")}`] : []),
			...(r.driverApps.length > 0 ? [`driver apps: ${r.driverApps.join(", ")}`] : []),
			...(r.paths.length > 0 ? [`paths: ${r.paths.map((p) => `${p.path} (${bytes(p.deltaBytes)})`).join(", ")}`] : []),
		];
		return `<li data-fw="${f.framework}"><strong>${escapeHtml(f.framework)}:</strong> ${escapeHtml(parts.length > 0 ? parts.join("; ") : "none")}</li>`;
	});
	return `<section id="residue"><h2>Residue</h2><ul class="plain">${items.join("")}</ul></section>`;
}

function problemSection(run: BenchRun): string {
	const bad = run.frameworks.filter((f) => !isOk(f));
	if (bad.length === 0) return `<section id="problems"><h2>Unsupported / failed</h2><p>None.</p></section>`;
	const items = bad.map((f) => {
		const name = `<strong>${escapeHtml(f.framework)}:</strong>`;
		if (f.status === "unsupported")
			return `<li data-fw="${f.framework}">${name} unsupported. ${escapeHtml(f.reason)}</li>`;
		if (f.status === "failed")
			return `<li data-fw="${f.framework}">${name} failed in phase <code>${escapeHtml(f.phase)}</code>. ${escapeHtml(f.error)}</li>`;
		return "";
	});
	return `<section id="problems"><h2>Unsupported / failed</h2><ul class="plain">${items.join("")}</ul></section>`;
}

/** Hidden until the inline script runs, so a no-JS reader never sees dead checkboxes. */
function toggleBox(run: BenchRun): string {
	const boxes = run.frameworks
		.map((f) => `<label><input type="checkbox" checked data-fw="${f.framework}"> ${escapeHtml(f.framework)}</label>`)
		.join("");
	return `<div class="toggle" id="fw-toggle" role="group" aria-label="Show frameworks" hidden>${boxes}</div>`;
}

const TOGGLE_JS = `(function(){var box=document.getElementById('fw-toggle');if(!box)return;box.hidden=false;box.addEventListener('change',function(e){var t=e.target;var fw=t.getAttribute('data-fw');if(!fw)return;var els=document.querySelectorAll('[data-fw="'+fw+'"]');for(var i=0;i<els.length;i++){if(els[i]!==t)els[i].classList.toggle('off',!t.checked);}});})();`;

/** JSON safe to embed in a `<script type="application/json">`: `<` can never open a closing tag. */
function embedJson(run: BenchRun): string {
	return JSON.stringify(run).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

/**
 * The whole report as ONE self-contained HTML file: inline CSS tokens (light and dark), server-rendered SVG
 * charts, the raw run JSON, and a tiny optional framework toggle. Pure and deterministic: the same run and
 * manifest always give the same bytes, and the page is fully readable with JavaScript off.
 */
export function renderHtml(run: BenchRun, manifest: Manifest): string {
	const title = `e2e framework benchmark — ${run.device.platform} ${run.startedAt.slice(0, 10)}`;
	const body = [
		`<h1>${escapeHtml(title)}</h1>`,
		`<p class="sub">Run <code>${escapeHtml(run.id)}</code>, started ${escapeHtml(run.startedAt)}</p>`,
		headerSection(run),
		toggleBox(run),
		fairnessSection(),
		summarySection(run),
		matrixSection(run, manifest),
		stepsSection(run),
		resourcesSection(run),
		residueSection(run),
		problemSection(run),
		`<footer>Generated by @delacour/warden-e2e-bench schema v${run.schemaVersion}, run <code>${escapeHtml(run.id)}</code>.</footer>`,
	].join("\n");
	return [
		`<!doctype html>`,
		`<html lang="en">`,
		`<head>`,
		`<meta charset="utf-8">`,
		`<meta name="viewport" content="width=device-width, initial-scale=1">`,
		`<meta name="color-scheme" content="light dark">`,
		`<title>${escapeHtml(title)}</title>`,
		`<style>${css()}</style>`,
		`</head>`,
		`<body>`,
		`<main>`,
		body,
		`</main>`,
		`<script type="application/json" id="bench-results">${embedJson(run)}</script>`,
		`<script>${TOGGLE_JS}</script>`,
		`</body>`,
		`</html>`,
		``,
	].join("\n");
}
