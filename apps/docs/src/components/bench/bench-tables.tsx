import { bytes, DASH, ms, pct, ratio } from "@delacour/warden-e2e-bench/src/report/format";
import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { type BenchSummary, isOk, label, type OkFramework } from "./bench-data";

/** A horizontally scrollable table that keeps the first column pinned on phones. */
function Scroll({ children, caption }: { children: ReactNode; caption: string }): ReactElement {
	return (
		<div className="not-prose my-4 overflow-x-auto rounded-[var(--radius-group)] bg-surface">
			<table className="w-full border-collapse text-sm tabular-nums">
				<caption className="sr-only">{caption}</caption>
				{children}
			</table>
		</div>
	);
}

const TH = "border-hairline border-b px-2.5 py-2 font-medium text-ink-2 whitespace-nowrap";
const TD = "border-hairline border-b px-2.5 py-2 whitespace-nowrap last-of-type:border-b-0";
const NUM = "text-right";
const FIRST = "sticky left-0 z-10 bg-surface text-left";

const cellMs = (n: number | undefined): string => ms(n);

/** Lowest value among the numbers given, so the best cell can be bolded; undefined when there are none. */
function lowest(values: readonly (number | undefined)[], positiveOnly = false): number | undefined {
	const nums = values.filter((v): v is number => v !== undefined && Number.isFinite(v) && (!positiveOnly || v > 0));
	return nums.length === 0 ? undefined : Math.min(...nums);
}

/** Per-test warm medians: bold = fastest in the row, ✗ = failed in some rep so not comparable. */
export function TestMatrix({ summary }: { summary: BenchSummary }): ReactElement {
	const fws = summary.frameworks;
	return (
		<Scroll caption="Warm median per test and framework">
			<thead>
				<tr>
					<th className={cn(TH, FIRST)} scope="col">
						Test
					</th>
					{fws.map((f) => (
						<th className={cn(TH, NUM)} key={f.framework} scope="col">
							{label(f.framework)}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{summary.tests.map((t) => (
					<tr key={t.id}>
						<th className={cn(TD, FIRST, "max-w-[14rem] whitespace-normal font-normal")} scope="row">
							{t.title}
						</th>
						{fws.map((f) => {
							const c = t.cells[f.framework];
							if (c === undefined) {
								return (
									<td className={cn(TD, NUM, "text-ink-2")} key={f.framework}>
										{DASH}
									</td>
								);
							}
							return (
								<td className={cn(TD, NUM, c.fastest && "font-bold")} key={f.framework}>
									{c.failing ? <span title="failed in at least one rep">✗ </span> : null}
									{ms(c.medianMs)}
									<span className="block font-normal text-ink-2 text-xs">{ratio(c.ratio)}</span>
								</td>
							);
						})}
					</tr>
				))}
			</tbody>
		</Scroll>
	);
}

type Row = {
	name: string;
	best: "min" | "none";
	positiveOnly?: boolean;
	pick: (f: OkFramework) => number | undefined;
	text: (n: number | undefined) => string;
};

const COLD_ROWS: readonly Row[] = [
	{ name: "Warm suite median", best: "min", pick: (f) => f.suite.median, text: cellMs },
	{ name: "Warm suite p95", best: "none", pick: (f) => f.suite.p95, text: cellMs },
	{ name: "Cold first run", best: "none", pick: (f) => f.coldRep1Ms, text: cellMs },
	{ name: "Cold-start cost", best: "min", positiveOnly: true, pick: (f) => f.coldStartMs, text: cellMs },
	{ name: "Prepare", best: "min", pick: (f) => f.prepareMs, text: cellMs },
	{ name: "Teardown", best: "min", pick: (f) => f.teardownMs, text: cellMs },
	{ name: "Overhead outside tests", best: "min", pick: (f) => f.overheadMs, text: cellMs },
	{
		name: "Run-to-run spread (cv)",
		best: "none",
		pick: (f) => f.suite.cvPct,
		text: (n) => (n === undefined ? DASH : `${n}%`),
	},
	{ name: "Pass rate", best: "none", pick: (f) => f.passRate, text: (n) => pct(n) },
	{ name: "Flake rate", best: "none", pick: (f) => f.flakeRate, text: (n) => pct(n) },
];

/** Frameworks as columns, metrics as rows; the lowest passing value of a "lower is better" row is bold. */
function MetricTable({
	summary,
	rows,
	caption,
}: {
	summary: BenchSummary;
	rows: readonly Row[];
	caption: string;
}): ReactElement {
	const fws = summary.frameworks;
	return (
		<Scroll caption={caption}>
			<thead>
				<tr>
					<th className={cn(TH, FIRST)} scope="col">
						Metric
					</th>
					{fws.map((f) => (
						<th className={cn(TH, NUM)} key={f.framework} scope="col">
							{label(f.framework)}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((row) => {
					const best =
						row.best === "min"
							? lowest(
									fws.map((f) => (isOk(f) && !f.failing ? row.pick(f) : undefined)),
									row.positiveOnly === true
								)
							: undefined;
					return (
						<tr key={row.name}>
							<th className={cn(TD, FIRST, "font-normal")} scope="row">
								{row.name}
							</th>
							{fws.map((f) => {
								if (!isOk(f)) {
									return (
										<td className={cn(TD, NUM, "text-ink-2")} key={f.framework}>
											{DASH}
										</td>
									);
								}
								const v = row.pick(f);
								return (
									<td
										className={cn(TD, best !== undefined && v === best && !f.failing && "font-bold")}
										key={f.framework}
									>
										{row.text(v)}
									</td>
								);
							})}
						</tr>
					);
				})}
			</tbody>
		</Scroll>
	);
}

export function StartupTable({ summary }: { summary: BenchSummary }): ReactElement {
	return (
		<MetricTable
			caption="Suite time, cold start, prepare, teardown and reliability"
			rows={COLD_ROWS}
			summary={summary}
		/>
	);
}

const RESOURCE_ROWS: readonly Row[] = [
	{
		name: "Host CPU avg",
		best: "min",
		pick: (f) => f.resources.host.cpuAvgPct,
		text: (n) => (n === undefined ? DASH : `${n.toFixed(1)}%`),
	},
	{
		name: "Host CPU peak",
		best: "min",
		pick: (f) => f.resources.host.cpuPeakPct,
		text: (n) => (n === undefined ? DASH : `${n.toFixed(0)}%`),
	},
	{ name: "Host memory avg", best: "min", pick: (f) => f.resources.host.rssAvgBytes, text: (n) => bytes(n) },
	{ name: "Host memory peak", best: "min", pick: (f) => f.resources.host.rssPeakBytes, text: (n) => bytes(n) },
	{
		name: "Simulator CPU avg",
		best: "min",
		pick: (f) => f.resources.sim.cpuAvgPct,
		text: (n) => (n === undefined ? DASH : `${n.toFixed(1)}%`),
	},
	{
		name: "Simulator CPU peak",
		best: "min",
		pick: (f) => f.resources.sim.cpuPeakPct,
		text: (n) => (n === undefined ? DASH : `${n.toFixed(0)}%`),
	},
];

export function ResourceTable({ summary }: { summary: BenchSummary }): ReactElement {
	return <MetricTable caption="Host and simulator CPU and memory" rows={RESOURCE_ROWS} summary={summary} />;
}

const FOOTPRINT_ROWS: readonly Row[] = [
	{
		name: "Suite source (lines)",
		best: "min",
		pick: (f) => f.footprint.loc,
		text: (n) => (n === undefined ? DASH : String(n)),
	},
	{ name: "Suite source (size)", best: "min", pick: (f) => f.footprint.sourceBytes, text: (n) => bytes(n) },
	{
		name: "Runner binaries on disk",
		best: "none",
		pick: (f) => f.footprint.binaryBytes,
		text: (n) => (n === 0 ? DASH : bytes(n)),
	},
	{ name: "Leftover processes", best: "none", pick: (f) => f.residue.processes, text: (n) => String(n ?? DASH) },
	{ name: "Leftover driver apps", best: "none", pick: (f) => f.residue.driverApps, text: (n) => String(n ?? DASH) },
	{ name: "Leftover directories", best: "none", pick: (f) => f.residue.paths, text: (n) => String(n ?? DASH) },
];

export function FootprintTable({ summary }: { summary: BenchSummary }): ReactElement {
	return <MetricTable caption="Footprint and residue" rows={FOOTPRINT_ROWS} summary={summary} />;
}

/** Versions, status and, for a framework that did not run, why. */
export function VersionTable({ summary }: { summary: BenchSummary }): ReactElement {
	return (
		<Scroll caption="Framework versions and status">
			<thead>
				<tr>
					<th className={cn(TH, FIRST)} scope="col">
						Framework
					</th>
					<th className={cn(TH, "text-left")} scope="col">
						Version
					</th>
					<th className={cn(TH, "text-left")} scope="col">
						Status
					</th>
				</tr>
			</thead>
			<tbody>
				{summary.frameworks.map((f) => (
					<tr key={f.framework}>
						<th className={cn(TD, FIRST, "font-medium")} scope="row">
							{label(f.framework)}
						</th>
						<td className={cn(TD, "text-left")}>{f.version ?? DASH}</td>
						<td className={cn(TD, "max-w-[22rem] whitespace-normal text-left")}>
							{f.status === "ok"
								? f.failing
									? `ran, ${pct(f.passRate)} of tests passed`
									: "ran, all tests passed"
								: null}
							{f.status === "unsupported" ? `not run: ${f.reason}` : null}
							{f.status === "failed" ? `failed in ${f.phase}: ${f.error}` : null}
						</td>
					</tr>
				))}
			</tbody>
		</Scroll>
	);
}
