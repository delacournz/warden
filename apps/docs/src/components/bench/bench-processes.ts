export type ProcessScope = "host" | "sim";

/** The fields of a summary process row the chart reads. */
export type ProcessInput = {
	name: string;
	scope: ProcessScope;
	cpuSeconds: number;
	rssAvgBytes: number;
	shareOfScopePct: number;
};

export type FrameworkProcesses = { framework: string; rows: readonly ProcessInput[] | undefined };

export type Segment = { name: string; cpuSeconds: number; slot: number | "other" };

export type StackedBar = { framework: string; total: number; segments: Segment[] };

export type ScopeChart = {
	scope: ProcessScope;
	/** Names that own a colour slot, in slot order. */
	legend: string[];
	bars: StackedBar[];
	/** The largest bar total, the shared axis maximum. */
	max: number;
};

export const MAX_NAMES = 6;
const OTHER = "other";

/**
 * Per scope: the top `MAX_NAMES` process names by CPU-seconds summed over every framework get a colour slot
 * (so a name keeps its colour in every bar); everything else, including a pre-existing `other` row, folds
 * into one `other` segment. Frameworks without rows for the scope are left out; undefined when none have any.
 */
export function shapeScope(scope: ProcessScope, fws: readonly FrameworkProcesses[]): ScopeChart | undefined {
	const withRows = fws.flatMap((f) => {
		const rows = (f.rows ?? []).filter((r) => r.scope === scope);
		return rows.length === 0 ? [] : [{ framework: f.framework, rows }];
	});
	if (withRows.length === 0) return undefined;
	const totals = new Map<string, number>();
	for (const f of withRows)
		for (const r of f.rows) if (r.name !== OTHER) totals.set(r.name, (totals.get(r.name) ?? 0) + r.cpuSeconds);
	const legend = [...totals.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, MAX_NAMES)
		.map(([name]) => name);
	const bars = withRows.map(({ framework, rows }): StackedBar => {
		const byName = new Map<string, number>();
		let other = 0;
		for (const r of rows) {
			if (legend.includes(r.name)) byName.set(r.name, (byName.get(r.name) ?? 0) + r.cpuSeconds);
			else other += r.cpuSeconds;
		}
		const segments: Segment[] = legend.flatMap((name, slot) => {
			const cpuSeconds = byName.get(name);
			return cpuSeconds === undefined || cpuSeconds <= 0 ? [] : [{ name, cpuSeconds, slot }];
		});
		if (other > 0) segments.push({ name: OTHER, cpuSeconds: other, slot: "other" });
		return { framework, total: segments.reduce((n, s) => n + s.cpuSeconds, 0), segments };
	});
	return { scope, legend, bars, max: Math.max(...bars.map((b) => b.total)) };
}
