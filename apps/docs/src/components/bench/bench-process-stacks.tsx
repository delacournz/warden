import { bytes } from "@delacour/warden-e2e-bench/src/report/format";
import type { ReactElement } from "react";
import { cn } from "@/lib/cn";
import { type BenchSummary, isOk, label } from "./bench-data";
import {
	type FrameworkProcesses,
	type ProcessScope,
	type ScopeChart,
	type Segment,
	shapeScope,
} from "./bench-processes";

const SCOPE_TITLE: Record<ProcessScope, string> = {
	host: "Host processes (the framework's own tree)",
	sim: "Simulator processes",
};

const slotClass = (slot: Segment["slot"]): string => `p-${slot}`;

const seconds = (n: number): string => `${n.toFixed(1)} s`;

function frameworksOf(summary: BenchSummary): FrameworkProcesses[] {
	return summary.frameworks.filter(isOk).map((f) => ({ framework: f.framework, rows: f.processes }));
}

/**
 * One stacked bar per framework, segments sized by CPU-seconds on a shared axis so bars compare by length.
 * Every segment has a native tooltip; the table behind the toggle repeats the numbers as text.
 */
function Stack({ chart, summary }: { chart: ScopeChart; summary: BenchSummary }): ReactElement {
	const rowsOf = (fw: string) =>
		summary.frameworks.flatMap((f) =>
			f.framework === fw && isOk(f) ? (f.processes ?? []).filter((r) => r.scope === chart.scope) : []
		);
	return (
		<section className="my-4 rounded-[var(--radius-group)] bg-surface p-3 sm:p-4">
			<h4 className="m-0 mb-3 font-medium text-ink text-sm">{SCOPE_TITLE[chart.scope]}</h4>
			<ul className="m-0 mb-3 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-ink-2 text-xs">
				{[
					...chart.legend,
					...(chart.bars.some((b) => b.segments.some((s) => s.slot === "other")) ? ["other"] : []),
				].map((name, i) => (
					<li className={cn(slotClass(name === "other" ? "other" : i), "flex items-center gap-1.5")} key={name}>
						<span aria-hidden="true" className="seg inline-block size-3 rounded-[3px]" />
						{name}
					</li>
				))}
			</ul>
			<ul className="m-0 flex list-none flex-col gap-3 p-0">
				{chart.bars.map((bar) => (
					<li key={bar.framework}>
						<div className="mb-1 flex justify-between gap-2 text-sm">
							<span className="text-ink">{label(bar.framework)}</span>
							<span className="font-mono text-ink-2 tabular-nums">{seconds(bar.total)}</span>
						</div>
						<div
							aria-label={`${label(bar.framework)} CPU-seconds by process: ${bar.segments.map((s) => `${s.name} ${seconds(s.cpuSeconds)}`).join(", ")}`}
							className="flex h-4 gap-0.5"
							role="img"
							style={{ width: `${chart.max > 0 ? (bar.total / chart.max) * 100 : 0}%` }}
						>
							{bar.segments.map((s) => (
								<span
									className={cn(
										slotClass(s.slot),
										"seg block h-full min-w-px first:rounded-l-[4px] last:rounded-r-[4px]"
									)}
									key={s.name}
									style={{ flexGrow: s.cpuSeconds, flexBasis: 0 }}
									title={`${s.name}: ${seconds(s.cpuSeconds)}`}
								/>
							))}
						</div>
					</li>
				))}
			</ul>
			<details className="mt-3 text-sm">
				<summary className="cursor-pointer text-ink-2">Table</summary>
				<div className="mt-2 flex flex-col gap-3">
					{chart.bars.map((bar) => {
						const rows = rowsOf(bar.framework);
						return (
							<div className="overflow-x-auto" key={bar.framework}>
								<table className="w-full border-collapse text-xs tabular-nums">
									<caption className="pb-1 text-left font-medium text-ink">{label(bar.framework)}</caption>
									<thead>
										<tr className="text-ink-2">
											<th className="px-2 py-1 text-left font-medium" scope="col">
												Process
											</th>
											<th className="px-2 py-1 text-right font-medium" scope="col">
												CPU-s
											</th>
											<th className="px-2 py-1 text-right font-medium" scope="col">
												Share
											</th>
											<th className="px-2 py-1 text-right font-medium" scope="col">
												RSS avg
											</th>
										</tr>
									</thead>
									<tbody>
										{rows.map((r) => (
											<tr className="border-hairline border-t" key={r.name}>
												<th className="px-2 py-1 text-left font-normal" scope="row">
													{r.name}
												</th>
												<td className="px-2 py-1 text-right">{seconds(r.cpuSeconds)}</td>
												<td className="px-2 py-1 text-right">{r.shareOfScopePct.toFixed(1)}%</td>
												<td className="px-2 py-1 text-right">{bytes(r.rssAvgBytes)}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						);
					})}
				</div>
			</details>
		</section>
	);
}

/**
 * Where the CPU goes: host CPU-seconds by process name for each framework (the warm-median rep), with the
 * simulator's processes as a second group when the run has them. Renders a one-line note for data that
 * predates per-process attribution (summary version 1), so nothing is drawn from missing numbers.
 */
export function ProcessStacks({ summary }: { summary: BenchSummary }): ReactElement {
	const fws = frameworksOf(summary);
	const charts = (["host", "sim"] as const).flatMap((scope) => {
		const c = shapeScope(scope, fws);
		return c === undefined ? [] : [c];
	});
	if (charts.length === 0) {
		return (
			<p className="text-ink-2 text-sm">This run predates per-process CPU attribution, so there is no breakdown.</p>
		);
	}
	return (
		<>
			{charts.map((c) => (
				<Stack chart={c} key={c.scope} summary={summary} />
			))}
		</>
	);
}
