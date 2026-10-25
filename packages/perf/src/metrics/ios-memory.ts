const UNIT_KB: Record<string, number> = { K: 1, M: 1024, G: 1024 ** 2 };

/** `168.4M` / `512K` / `1.1G` to kilobytes; undefined for anything else. */
export function sizeToKb(text: string): number | undefined {
	const m = /^([\d.]+)([KMG])$/.exec(text.trim());
	return m === null ? undefined : Math.round(Number(m[1]) * (UNIT_KB[m[2] ?? "K"] ?? 1));
}

export type LeakType = { type: string; count: number };

export type LeaksSummary = {
	leakCount: number;
	leakedBytes: number;
	/** the leaked object types by instance count, largest first (at most 5) */
	types: LeakType[];
};

/**
 * Parses `leaks <pid>` output: the `N leaks for M total leaked bytes.` line and the `Leak: 0x… size=… zone: …
 * <type>  <kind>` rows. Undefined when the summary line is missing (the tool failed or the process is gone).
 */
export function parseLeaks(text: string): LeaksSummary | undefined {
	const m = /Process \d+: (\d+) leaks? for (\d+) total leaked bytes/.exec(text);
	if (m === null) return undefined;
	const counts = new Map<string, number>();
	for (const row of text.matchAll(/^Leak: 0x[0-9a-f]+\s+size=\d+\s+zone: \S+\s+(.+?)(?:\s{2,}|$)/gm)) {
		const type = row[1]?.trim();
		if (type !== undefined && type !== "") counts.set(type, (counts.get(type) ?? 0) + 1);
	}
	const types = [...counts]
		.map(([type, count]) => ({ type, count }))
		.sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1))
		.slice(0, 5);
	return { leakCount: Number(m[1]), leakedBytes: Number(m[2]), types };
}

export type VmRegion = { type: string; residentKb: number; dirtyKb: number; swappedKb: number };

export type VmmapSummary = {
	footprintKb: number;
	footprintPeakKb?: number;
	/** the five regions with the most dirty memory */
	regions: VmRegion[];
};

const REGION_ROW = /^(.+?)\s{2,}(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+\d+\s*$/;

/** The REGION TYPE table rows (up to its TOTAL), unsorted. */
function parseRegions(lines: readonly string[]): VmRegion[] {
	const header = lines.findIndex((l) => /^REGION TYPE\b/.test(l));
	if (header < 0) return [];
	const regions: VmRegion[] = [];
	for (const line of lines.slice(header + 2)) {
		const m = REGION_ROW.exec(line);
		const type = (m?.[1] ?? "").trim();
		if (m === null || type === "TOTAL") break;
		regions.push({
			type,
			residentKb: sizeToKb(m[3] ?? "") ?? 0,
			dirtyKb: sizeToKb(m[4] ?? "") ?? 0,
			swappedKb: sizeToKb(m[5] ?? "") ?? 0,
		});
	}
	return regions;
}

/** Parses `vmmap --summary <pid>`: `Physical footprint` (and peak) plus the top REGION TYPE rows by dirty size. Undefined without a footprint. */
export function parseVmmap(text: string): VmmapSummary | undefined {
	const footprint = /^Physical footprint:\s+(\S+)/m.exec(text)?.[1];
	const footprintKb = footprint === undefined ? undefined : sizeToKb(footprint);
	if (footprintKb === undefined) return undefined;
	const peak = /^Physical footprint \(peak\):\s+(\S+)/m.exec(text)?.[1];
	const peakKb = peak === undefined ? undefined : sizeToKb(peak);
	const regions = parseRegions(text.split("\n")).sort((a, b) => b.dirtyKb - a.dirtyKb);
	return { footprintKb, ...(peakKb !== undefined ? { footprintPeakKb: peakKb } : {}), regions: regions.slice(0, 5) };
}
