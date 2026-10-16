import { bytes, ms, ratio } from "@delacour/warden-e2e-bench/src/report/format";
import { type BarGroup, type BoxGroup, barChart, boxChart, tickMs } from "@delacour/warden-e2e-bench/src/report/svg";
import type { ReactElement } from "react";
import { type BenchSummary, isOk, label, type OkFramework } from "./bench-data";

/**
 * Renders SVG built by the bench package's pure chart functions. The markup is generated from committed,
 * escaped data (every string passes through `escapeHtml`), never from user input.
 */
function Svg({ svg, caption }: { svg: string; caption: string }): ReactElement {
	return (
		<figure className="my-4 rounded-[var(--radius-group)] bg-surface p-3 sm:p-4">
			<div
				// biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, escaped SVG from the pure chart builders
				dangerouslySetInnerHTML={{ __html: svg }}
			/>
			<figcaption className="mt-2 text-ink-2 text-xs">{caption}</figcaption>
		</figure>
	);
}

const describe = (title: string, items: readonly string[]): string => `${title}: ${items.join("; ")}`;

/** Warm suite wall time per framework: median bar, p95 whisker, cold rep 1 dot. */
export function SuiteChart({ summary }: { summary: BenchSummary }): ReactElement {
	const oks = summary.frameworks.filter(isOk);
	const groups: BarGroup[] = oks.map((f) => ({
		label: `${label(f.framework)}${f.failing ? " ✗ failing tests" : ""}`,
		bars: [
			{
				series: f.framework,
				value: f.suite.median,
				whiskerTo: f.suite.p95,
				...(f.coldRep1Ms !== undefined ? { marker: f.coldRep1Ms } : {}),
				label: `${ms(f.suite.median)} · ${ratio(f.ratio)}${f.failing ? " ✗" : ""}`,
				detail: `p95 ${ms(f.suite.p95)}, cold rep 1 ${ms(f.coldRep1Ms)}`,
				best: f.fastest,
			},
		],
	}));
	const svg = barChart({
		id: "bench-suite",
		title: "Warm suite wall time per framework",
		desc: describe(
			"Warm suite median",
			oks.map((f) => `${label(f.framework)} ${ms(f.suite.median)}`)
		),
		tickLabel: tickMs,
		groups,
	});
	return (
		<Svg
			caption="Bar: warm median. Whisker: p95. Dot: cold first run. The ratio is the median over the fastest framework that passed every test. A ✗ marks a framework with failing tests, whose time is not comparable."
			svg={svg}
		/>
	);
}

/** Step latency (every step of every warm and cold rep): min..p95 box, median tick, max whisker. */
export function StepChart({ summary }: { summary: BenchSummary }): ReactElement {
	const oks = summary.frameworks.filter(isOk).filter((f) => f.stepLatency !== undefined);
	const groups: BoxGroup[] = [
		{
			label: "Step latency",
			boxes: oks.flatMap((f) =>
				f.stepLatency === undefined
					? []
					: [
							{
								series: f.framework,
								min: f.stepLatency.min,
								median: f.stepLatency.median,
								p95: f.stepLatency.p95,
								max: f.stepLatency.max,
								label: `${label(f.framework)} · median ${ms(f.stepLatency.median)}`,
								detail: `p95 ${ms(f.stepLatency.p95)}, max ${ms(f.stepLatency.max)}, ${f.stepLatency.n} steps`,
							},
						]
			),
		},
	];
	const svg = boxChart({
		id: "bench-steps",
		title: "Per-step latency per framework",
		desc: describe(
			"Median step latency",
			oks.map((f) => `${label(f.framework)} ${ms(f.stepLatency?.median)}`)
		),
		tickLabel: tickMs,
		groups,
	});
	return (
		<Svg
			caption="Whisker: min to max. Box: min to p95. Tick: median. Step timings are not defined the same way in every tool, so compare per-test totals first."
			svg={svg}
		/>
	);
}

type ResourceMetric = {
	id: string;
	title: string;
	pick: (f: OkFramework) => number;
	text: (v: number) => string;
	tick: (v: number) => string;
};

const RESOURCE_METRICS: readonly ResourceMetric[] = [
	{
		id: "cpu",
		title: "Host CPU, average",
		pick: (f) => f.resources.host.cpuAvgPct,
		text: (v) => `${v.toFixed(1)}%`,
		tick: (v) => `${v}%`,
	},
	{
		id: "rss",
		title: "Host memory, peak",
		pick: (f) => f.resources.host.rssPeakBytes,
		text: (v) => bytes(v),
		tick: (v) => (v === 0 ? "0" : bytes(v)),
	},
];

/** One bar per framework per metric, each on its own chart (never two scales on one axis). */
export function ResourceCharts({ summary }: { summary: BenchSummary }): ReactElement {
	const oks = summary.frameworks.filter(isOk);
	return (
		<>
			{RESOURCE_METRICS.map((m) => {
				const groups: BarGroup[] = [
					{
						label: m.title,
						bars: oks.map((f) => ({
							series: f.framework,
							value: m.pick(f),
							label: `${label(f.framework)} · ${m.text(m.pick(f))}`,
						})),
					},
				];
				const svg = barChart({
					id: `bench-res-${m.id}`,
					title: m.title,
					desc: describe(
						m.title,
						oks.map((f) => `${label(f.framework)} ${m.text(m.pick(f))}`)
					),
					tickLabel: m.tick,
					groups,
				});
				return (
					<Svg
						caption="Sampled every 500 ms while the suite runs. Host means the framework's own processes, summed per process, so shared pages can be counted twice."
						key={m.id}
						svg={svg}
					/>
				);
			})}
		</>
	);
}

/** The colour key: swatch plus name for every framework in the run. */
export function Legend({ summary }: { summary: BenchSummary }): ReactElement {
	return (
		<ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-ink-2 text-sm">
			{summary.frameworks.map((f) => (
				<li className={`s-${f.framework} flex items-center gap-1.5`} key={f.framework}>
					<span aria-hidden="true" className="sw inline-block size-3 rounded-[3px]" />
					{label(f.framework)}
				</li>
			))}
		</ul>
	);
}
