/** One frame from the `---PROFILEDATA---` table, in device CLOCK_MONOTONIC nanoseconds. */
export type RawFrame = { intendedVsyncNs: number; completedNs: number };

export type GfxSummary = {
	totalFrames: number;
	jankyFrames: number;
	jankyPct: number;
	percentilesMs: { p50?: number; p90?: number; p95?: number; p99?: number };
};

export type GfxInfo = {
	/** `Uptime:` header: device monotonic clock (ms) when the dump was taken; the frame clock's "now" */
	uptimeMs?: number;
	summary?: GfxSummary;
	/** frames with `Flags == 0`, ordered by intended vsync */
	frames: RawFrame[];
};

const PROFILE_MARK = "---PROFILEDATA---";

const num = (re: RegExp, text: string): number | undefined => {
	const m = re.exec(text);
	return m?.[1] === undefined ? undefined : Number(m[1]);
};

function parseSummary(text: string): GfxSummary | undefined {
	const janky = /^Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/m.exec(text);
	const total = num(/^Total frames rendered:\s*(\d+)/m, text);
	if (janky?.[1] === undefined || janky[2] === undefined || total === undefined) return undefined;
	const percentilesMs: GfxSummary["percentilesMs"] = {};
	for (const [key, p] of [
		["p50", 50],
		["p90", 90],
		["p95", 95],
		["p99", 99],
	] as const) {
		const v = num(new RegExp(`^${p}th percentile:\\s*(\\d+)ms`, "m"), text);
		if (v !== undefined) percentilesMs[key] = v;
	}
	return { totalFrames: total, jankyFrames: Number(janky[1]), jankyPct: Number(janky[2]), percentilesMs };
}

/** Rows of the PROFILEDATA table (columns found by header name; `Flags != 0` rows skipped); undefined without a table. */
function parseFrameTable(lines: readonly string[]): RawFrame[] | undefined {
	const start = lines.findIndex((l) => l.trim() === PROFILE_MARK);
	if (start === -1) return undefined;
	const header = (lines[start + 1] ?? "").trim().split(",");
	const flagsAt = header.indexOf("Flags");
	const intendedAt = header.indexOf("IntendedVsync");
	const completedAt = header.indexOf("FrameCompleted");
	if (flagsAt === -1 || intendedAt === -1 || completedAt === -1) return undefined;
	const frames: RawFrame[] = [];
	for (const raw of lines.slice(start + 2)) {
		const line = raw.trim();
		if (line === PROFILE_MARK) break;
		const cols = line.split(",");
		const intendedVsyncNs = Number(cols[intendedAt]);
		const completedNs = Number(cols[completedAt]);
		const usable = Number(cols[flagsAt]) === 0 && completedNs >= intendedVsyncNs;
		if (usable && Number.isFinite(intendedVsyncNs) && Number.isFinite(completedNs)) {
			frames.push({ intendedVsyncNs, completedNs });
		}
	}
	return frames;
}

/**
 * Parse `dumpsys gfxinfo <pkg> framestats`: the summary block and the PROFILEDATA CSV. `undefined` when the dump
 * has neither (app not running).
 */
export function parseGfxinfo(text: string): GfxInfo | undefined {
	const uptimeMs = num(/^Uptime:\s*(\d+)/m, text);
	const summary = parseSummary(text);
	const table = parseFrameTable(text.split("\n"));
	if (summary === undefined && table === undefined) return undefined;
	const frames = [...(table ?? [])].sort((a, b) => a.intendedVsyncNs - b.intendedVsyncNs);
	return { ...(uptimeMs !== undefined ? { uptimeMs } : {}), ...(summary ? { summary } : {}), frames };
}
