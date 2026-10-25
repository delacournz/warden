export type MeminfoCategory = { name: string; pssKb: number };

export type Meminfo = {
	pid?: number;
	totalPssKb: number;
	/** absent on Android versions whose `dumpsys meminfo` has no Rss column */
	totalRssKb?: number;
	/** the five largest `App Summary` categories by PSS */
	categories: MeminfoCategory[];
};

const TOP_CATEGORIES = 5;

type Token = { value: number; end: number };

function numberTokens(text: string): Token[] {
	return [...text.matchAll(/\d+/g)].map((m) => ({ value: Number(m[0]), end: (m.index ?? 0) + m[0].length }));
}

/** The PSS of one App Summary row's figures: the first number, or on a two-column layout only one under the Pss header (`Unknown` has just an Rss figure). */
function pssOf(figures: string, offset: number, pssEnd: number | undefined): number | undefined {
	const tokens = numberTokens(figures).map((t) => ({ ...t, end: t.end + offset }));
	const pss = pssEnd === undefined ? tokens[0] : tokens.find((t) => t.end <= pssEnd + 2);
	return pss !== undefined && pss.value > 0 ? pss.value : undefined;
}

/** App Summary rows (`Java Heap:    20548     27688`), PSS only. */
function summaryCategories(lines: readonly string[]): MeminfoCategory[] {
	const start = lines.findIndex((l) => /^\s*App Summary\b/.test(l));
	if (start < 0) return [];
	const header = lines[start + 1] ?? "";
	const twoColumns = header.includes("Rss(KB)") && header.includes("Pss(KB)");
	const pssEnd = twoColumns ? header.indexOf("Pss(KB)") + "Pss(KB)".length : undefined;
	const out: MeminfoCategory[] = [];
	for (const line of lines.slice(start + 2)) {
		const m = /^(\s*[A-Za-z][A-Za-z ]*?):(.*)$/.exec(line);
		if (m === null) continue;
		const name = (m[1] ?? "").trim();
		if (/^TOTAL/.test(name)) break;
		const pss = pssOf(m[2] ?? "", (m[1] ?? "").length + 1, pssEnd);
		if (pss !== undefined) out.push({ name, pssKb: pss });
	}
	return out.sort((a, b) => b.pssKb - a.pssKb).slice(0, TOP_CATEGORIES);
}

/**
 * Parses `adb shell dumpsys meminfo <package>` (the `** MEMINFO in pid … **` block): TOTAL PSS/RSS and the
 * top App Summary categories. Undefined when the package has no running process (`No process found for: …`)
 * or the output carries no total.
 */
export function parseMeminfo(text: string): Meminfo | undefined {
	const lines = text.split("\n");
	const pssLine = /TOTAL PSS:\s+(\d+)/.exec(text);
	const legacySummary = /^\s*TOTAL:\s+(\d+)/m.exec(text);
	const totalRow = /^\s*TOTAL\s+(\d+)/m.exec(text);
	const totalPss = pssLine?.[1] ?? legacySummary?.[1] ?? totalRow?.[1];
	if (totalPss === undefined || !/MEMINFO in pid/.test(text)) return undefined;
	const rss = /TOTAL RSS:\s+(\d+)/.exec(text)?.[1];
	const pid = /MEMINFO in pid (\d+)/.exec(text)?.[1];
	return {
		...(pid !== undefined ? { pid: Number(pid) } : {}),
		totalPssKb: Number(totalPss),
		...(rss !== undefined ? { totalRssKb: Number(rss) } : {}),
		categories: summaryCategories(lines),
	};
}
