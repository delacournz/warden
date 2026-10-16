import { bytes, ms, pct, ratio } from "@delacour/warden-e2e-bench/src/report/format";
import { createContext, type ReactElement, type ReactNode, use, useState } from "react";
import { cn } from "@/lib/cn";
import { gitConfig, githubUrl } from "@/lib/shared";
import { Legend, ResourceCharts, StepChart, SuiteChart } from "./bench-chart";
import { type BenchSummary, cleanFrameworks, isOk, label, PLATFORM_LABEL, SUMMARIES } from "./bench-data";
import { FootprintTable, ResourceTable, StartupTable, TestMatrix, VersionTable } from "./bench-tables";

const BenchContext = createContext<BenchSummary | undefined>(undefined);

function useSummary(): BenchSummary {
	const summary = use(BenchContext);
	if (summary === undefined) throw new Error("bench components must sit inside <BenchProvider>");
	return summary;
}

const reportUrl = (s: BenchSummary): string =>
	`${githubUrl}/blob/${gitConfig.branch}/docs/bench/${s.platform}-${s.date}.md`;

function Pill({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: ReactNode;
}): ReactElement {
	return (
		<button
			aria-pressed={active}
			className={cn(
				"rounded-full px-3 py-1 font-medium text-sm transition-colors",
				active ? "bg-ink text-surface" : "bg-fill text-ink-2 hover:text-ink"
			)}
			onClick={onClick}
			type="button"
		>
			{children}
		</button>
	);
}

/** Picks the platform and run date when more than one summary is committed; always shows which run is on screen. */
export function BenchProvider({ children }: { children: ReactNode }): ReactElement {
	const [index, setIndex] = useState(0);
	const summary = SUMMARIES[index];
	if (summary === undefined) return <p>No benchmark results are published yet.</p>;
	const platforms = [...new Set(SUMMARIES.map((s) => s.platform))];
	const dates = SUMMARIES.flatMap((s, i) => (s.platform === summary.platform ? [{ s, i }] : []));
	return (
		<BenchContext value={summary}>
			<div className="bench not-prose">
				<div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2">
					{platforms.length > 1 ? (
						<fieldset aria-label="Platform" className="m-0 flex gap-2 border-0 p-0">
							{platforms.map((p) => (
								<Pill
									active={p === summary.platform}
									key={p}
									onClick={() => setIndex(SUMMARIES.findIndex((s) => s.platform === p))}
								>
									{PLATFORM_LABEL[p] ?? p}
								</Pill>
							))}
						</fieldset>
					) : null}
					{dates.length > 1 ? (
						<fieldset aria-label="Run date" className="m-0 flex gap-2 border-0 p-0">
							{dates.map(({ s, i }) => (
								<Pill active={i === index} key={s.runId} onClick={() => setIndex(i)}>
									{s.date}
								</Pill>
							))}
						</fieldset>
					) : null}
					<p className="m-0 text-ink-2 text-sm">
						{PLATFORM_LABEL[summary.platform] ?? summary.platform} run of {summary.date} ·{" "}
						<a className="underline underline-offset-2" href={reportUrl(summary)} rel="noreferrer" target="_blank">
							full report
						</a>
					</p>
				</div>
			</div>
			<div className="bench">{children}</div>
		</BenchContext>
	);
}

function Tile({ label: name, value, detail }: { label: string; value: string; detail: ReactNode }): ReactElement {
	return (
		<div className="rounded-[var(--radius-group)] bg-surface p-4">
			<p className="m-0 text-ink-2 text-xs uppercase tracking-wide">{name}</p>
			<p className="mt-1 mb-0 font-medium font-mono text-2xl text-ink tracking-tight">{value}</p>
			<p className="mt-1 mb-0 text-ink-2 text-sm">{detail}</p>
		</div>
	);
}

/** Headline numbers: the fastest framework that passed everything, the spread, and who did not pass. */
export function BenchHero(): ReactElement {
	const s = useSummary();
	const oks = s.frameworks.filter(isOk);
	const clean = cleanFrameworks(s);
	const fastest = clean.reduce<(typeof clean)[number] | undefined>(
		(best, f) => (best === undefined || f.suite.median < best.suite.median ? f : best),
		undefined
	);
	const slowest = clean.reduce<(typeof clean)[number] | undefined>(
		(worst, f) => (worst === undefined || f.suite.median > worst.suite.median ? f : worst),
		undefined
	);
	const failing = oks.filter((f) => f.failing);
	const notRun = s.frameworks.length - oks.length;
	return (
		<div className="bench not-prose">
			<div className="my-6 grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-4">
				<Tile
					detail={
						fastest === undefined ? "no framework passed every test" : `${label(fastest.framework)}, warm suite median`
					}
					label="Fastest, all tests passing"
					value={fastest === undefined ? "none" : ms(fastest.suite.median)}
				/>
				<Tile
					detail={
						slowest === undefined || fastest === undefined
							? "needs two passing frameworks"
							: `${label(fastest.framework)} to ${label(slowest.framework)}`
					}
					label="Ratio spread"
					value={slowest === undefined ? "n/a" : `1× to ${ratio(slowest.ratio).replace("×", "")}×`}
				/>
				<Tile
					detail={
						failing.length === 0
							? "every framework that ran passed every test"
							: failing.map((f) => `${label(f.framework)} ${pct(f.passRate)}`).join(", ")
					}
					label="Passed every test"
					value={`${clean.length} of ${s.frameworks.length}`}
				/>
				<Tile
					detail={`${s.options.runs} runs each, run 1 cold${notRun > 0 ? `, ${notRun} did not run` : ""}`}
					label="Suite"
					value="8 tests"
				/>
			</div>
			<Legend summary={s} />
		</div>
	);
}

export function BenchSuite(): ReactElement {
	return (
		<div className="bench not-prose">
			<SuiteChart summary={useSummary()} />
		</div>
	);
}

export function BenchMatrix(): ReactElement {
	return (
		<div className="bench not-prose">
			<TestMatrix summary={useSummary()} />
			<p className="text-ink-2 text-xs">
				Bold: fastest in the row. ✗: the test failed in at least one run, so the time is not comparable.
			</p>
		</div>
	);
}

export function BenchSteps(): ReactElement {
	return (
		<div className="bench not-prose">
			<StepChart summary={useSummary()} />
		</div>
	);
}

export function BenchStartup(): ReactElement {
	return (
		<div className="bench not-prose">
			<StartupTable summary={useSummary()} />
		</div>
	);
}

export function BenchResources(): ReactElement {
	const s = useSummary();
	return (
		<div className="bench not-prose">
			<ResourceCharts summary={s} />
			<ResourceTable summary={s} />
		</div>
	);
}

export function BenchFootprint(): ReactElement {
	return (
		<div className="bench not-prose">
			<FootprintTable summary={useSummary()} />
		</div>
	);
}

/** Versions, run facts (host, device, app hash) and the link to the full report. */
export function BenchRun(): ReactElement {
	const s = useSummary();
	return (
		<div className="bench not-prose">
			<VersionTable summary={s} />
			<dl className="my-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-[var(--radius-group)] bg-surface p-4 text-sm">
				<dt className="text-ink-2">Host</dt>
				<dd className="m-0">
					{s.host.model}, {s.host.cpu}, {s.host.cores} cores, {bytes(s.host.memBytes)}, macOS {s.host.macos}
				</dd>
				<dt className="text-ink-2">Device</dt>
				<dd className="m-0">
					{s.device.name ?? "simulator"} {s.device.runtime ?? ""}
				</dd>
				<dt className="text-ink-2">App</dt>
				<dd className="m-0 break-all font-mono text-xs">
					{s.app.bundleId}, {bytes(s.app.bytes)}, build {s.app.hash}, sha256 {s.app.sha256}
				</dd>
				<dt className="text-ink-2">Tools</dt>
				<dd className="m-0">
					bun {s.host.bun}, warden {s.host.warden}
				</dd>
				<dt className="text-ink-2">Run</dt>
				<dd className="m-0">
					{s.options.runs} runs per framework, {s.options.retries} retries, load average {s.host.loadAvgAtStart} at
					start
				</dd>
				<dt className="text-ink-2">Report</dt>
				<dd className="m-0">
					<a className="underline underline-offset-2" href={reportUrl(s)} rel="noreferrer" target="_blank">
						docs/bench/{s.platform}-{s.date}.md
					</a>
				</dd>
			</dl>
		</div>
	);
}
