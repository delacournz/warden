import type { ReactElement } from "react";

type Segment = { from: number; to: number; tone: "solid" | "soft"; label?: string };
type Row = { name: string; detail: string; value: string; segments: readonly Segment[] };

const AXIS_MAX = 240;
const TICKS = [0, 60, 120, 180, 240] as const;

/** The measured boots from the salient e2e suite (SAL-GOLDEN), drawn to one time scale. */
const ROWS: readonly Row[] = [
	{
		name: "Fresh create + first boot",
		detail: "simctl create, then the one-time data migration",
		value: "146–239 s",
		segments: [
			{ from: 0, to: 146, tone: "solid" },
			{ from: 146, to: 239, tone: "soft" },
		],
	},
	{
		name: "Clone a settled golden + boot",
		detail: "clone 3.7 s + boot 11.9 s, what claim does for a new sim",
		value: "15.6 s",
		segments: [{ from: 0, to: 15.6, tone: "solid", label: "clone 3.7 s + boot 11.9 s" }],
	},
	{
		name: "3 clones booted in parallel",
		detail: "three new sims at once",
		value: "~20 s",
		segments: [{ from: 0, to: 20, tone: "solid" }],
	},
	{
		name: "Reuse an existing pool device",
		detail: "second boot; warden always reuses first",
		value: "~6.5 s",
		segments: [{ from: 0, to: 6.5, tone: "solid" }],
	},
];

const pct = (s: number) => `${(s / AXIS_MAX) * 100}%`;

/**
 * Four measured boots on one 0–240 s axis, so the gap is read as distance
 * rather than as a claim. The numbers are the README's; nothing is rounded up.
 */
export function BootChart(): ReactElement {
	return (
		<figure className="rounded-[22px] bg-surface p-5 sm:p-8">
			<ol className="flex flex-col gap-7">
				{ROWS.map((row) => (
					<li className="grid gap-2 sm:grid-cols-[minmax(0,15rem)_1fr_8.5rem] sm:items-center sm:gap-6" key={row.name}>
						<div>
							<p className="font-medium text-ink">{row.name}</p>
							<p className="text-ink-2 text-sm">{row.detail}</p>
						</div>
						<div className="relative h-7 rounded-md bg-ground">
							{row.segments.map((seg) => (
								<span
									className={
										seg.tone === "solid"
											? "absolute inset-y-0 rounded-md bg-ink"
											: "absolute inset-y-0 rounded-md bg-ink-2/40"
									}
									key={`${seg.from}-${seg.to}`}
									style={{ left: pct(seg.from), width: pct(seg.to - seg.from) }}
									title={seg.label}
								/>
							))}
						</div>
						<p className="whitespace-nowrap font-medium font-mono text-2xl text-ink tabular-nums tracking-tight sm:text-right">
							{row.value}
						</p>
					</li>
				))}
			</ol>
			<div aria-hidden="true" className="mt-4 hidden sm:grid sm:grid-cols-[minmax(0,15rem)_1fr_8.5rem] sm:gap-6">
				<span />
				<div className="relative h-4 font-mono text-[11px] text-ink-2 tabular-nums">
					{TICKS.map((t) => (
						<span
							className="-translate-x-1/2 absolute whitespace-nowrap last:-translate-x-full first:translate-x-0"
							key={t}
							style={{ left: pct(t) }}
						>
							{t} s
						</span>
					))}
				</div>
			</div>
			<figcaption className="mt-6 flex flex-col gap-2 border-hairline border-t pt-4 text-ink-2 text-sm">
				<span className="flex flex-wrap items-center gap-x-5 gap-y-1">
					<span className="inline-flex items-center gap-2">
						<span aria-hidden="true" className="h-2.5 w-5 rounded-sm bg-ink" />
						measured time
					</span>
					<span className="inline-flex items-center gap-2">
						<span aria-hidden="true" className="h-2.5 w-5 rounded-sm bg-ink-2/40" />
						spread across runs (146 s best, 239 s worst)
					</span>
				</span>
				<span>
					Measured on the salient e2e suite. Clones are APFS copy-on-write, about 30 MB each; if cloning fails warden
					falls back to <code className="font-mono">simctl create</code>.
				</span>
			</figcaption>
		</figure>
	);
}
