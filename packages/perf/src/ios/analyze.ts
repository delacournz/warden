import type { Finding } from "../shared/findings.types";
import type { ReportSection } from "../shared/render-md";
import { cellFrames, cellNumber, cellPid, cellText, type StackFrame, type XmlNode } from "./xml-rows";

export type FrameClass = "app" | "rn" | "system";

const SYSTEM_PREFIXES = ["/usr/lib/", "/usr/libexec/", "/System/Library/", "/System/iOSSupport/", "/AppleInternal/"];
const RN_NAME = /^(?:[-+]\[)?(?:RCT|RN[A-Z]|Yoga|YG|hermes|facebook::|folly::|jsi|JSI|react::|ReactCommon)/;
const RN_BINARY = /(?:^|\/)(?:hermes|React|ReactNativeDependencies|ReactCommon|Yoga)(?:\.framework)?(?:\/|$)/i;

/** app code, React Native runtime, or the OS (simulator runtime roots count as the OS even though they live under CoreSimulator). */
export function classifyFrame(frame: StackFrame): FrameClass {
	const path = frame.binary;
	if (path.includes("/RuntimeRoot/") || path.includes("/Runtimes/")) return "system";
	if (SYSTEM_PREFIXES.some((p) => path.startsWith(p))) return "system";
	if (RN_NAME.test(frame.name) || RN_BINARY.test(path)) return "rn";
	if (path === "" && /^(?:0x[0-9a-f]+|\?)$/i.test(frame.name)) return "system";
	return "app";
}

/** The frame a sample is blamed on: innermost app / third-party frame, else innermost React Native frame, else none (system only). */
export function dominantFrame(frames: readonly StackFrame[]): { frame: StackFrame; cls: FrameClass } | undefined {
	let rn: StackFrame | undefined;
	for (const frame of frames) {
		const cls = classifyFrame(frame);
		if (cls === "app") return { frame, cls };
		if (cls === "rn" && rn === undefined) rn = frame;
	}
	return rn === undefined ? undefined : { frame: rn, cls: "rn" };
}

/**
 * `Main Thread (0x1a2) (App, pid: 42)` → `Main Thread`; React Native's JS / shadow queues get stable names. On a
 * simulator the main thread is labelled with the process name (`App (0x1a2) (App, pid: 42)`).
 */
export function normaliseThread(raw: string): string {
	const process = /\(([^()]*),\s*pid:\s*\d+[^()]*\)\s*$/.exec(raw)?.[1]?.trim();
	let name = raw
		.replace(/\s*\([^()]*pid:\s*\d+[^()]*\)\s*$/, "")
		.replace(/\s*\(\d+\)\s*$/, "")
		.replace(/\s*\(0x[0-9a-fA-F]+\)/g, "")
		.replace(/\s+0x[0-9a-fA-F]+\b/g, "")
		.trim();
	if (name === "" || /^Thread$/i.test(name)) name = "Thread";
	if (/^Main Thread$/i.test(name) || (process !== undefined && name === process)) return "Main Thread";
	if (/hermes|mqt_js|mqt_v_js|react\.JavaScript|\bJS\b/i.test(name)) return "JS Thread";
	if (/ShadowQueue|mqt_v_shadow|\bYoga\b/i.test(name)) return "Shadow Thread";
	return name;
}

export type NativeSample = { timeNs: number; thread: string; pid?: number; weightNs: number; frames: StackFrame[] };

export type HangWindow = { id: number; startNs: number; endNs: number };

type Counter = Map<string, number>;

type Bucket = { samples: number; functions: Counter; chains: Counter };

export type SampleStats = {
	sampleCount: number;
	totalNs: number;
	/** samples with no app or React Native frame */
	systemSamples: number;
	hotspots: Array<{ thread: string; frame: string; binary: string; cls: FrameClass; samples: number; ns: number }>;
	threads: Array<{ thread: string; samples: number }>;
	windows: Map<number, Bucket>;
};

const bump = (map: Counter, key: string, by = 1): void => void map.set(key, (map.get(key) ?? 0) + by);

/** The non-system frames around the blamed one, outermost first: `a > b > c`. */
function chainOf(frames: readonly StackFrame[]): string {
	const kept: string[] = [];
	for (const frame of frames) {
		if (classifyFrame(frame) === "system") continue;
		if (kept[kept.length - 1] !== frame.name) kept.push(frame.name);
		if (kept.length === 5) break;
	}
	return kept.reverse().join(" > ");
}

export type SampleAccumulator = { add: (sample: NativeSample) => void; stats: () => SampleStats };

/**
 * Fold samples into per-(thread, frame) self counts and, for every hang window, the main-thread samples inside it.
 * `pid` drops samples of other processes (`--all-processes` recordings). Only counters are kept, never samples.
 */
export function createAccumulator(opts: { pid?: number; windows?: readonly HangWindow[] } = {}): SampleAccumulator {
	const windows = [...(opts.windows ?? [])].sort((a, b) => a.startNs - b.startNs);
	const buckets = new Map<number, Bucket>(
		windows.map((w) => [w.id, { samples: 0, functions: new Map(), chains: new Map() }])
	);
	const hot = new Map<
		string,
		{ thread: string; frame: string; binary: string; cls: FrameClass; samples: number; ns: number }
	>();
	const threads: Counter = new Map();
	let sampleCount = 0;
	let totalNs = 0;
	let systemSamples = 0;

	function windowAt(timeNs: number): HangWindow | undefined {
		let lo = 0;
		let hi = windows.length - 1;
		let hit = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if ((windows[mid]?.startNs ?? Number.POSITIVE_INFINITY) <= timeNs) {
				hit = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		const w = hit === -1 ? undefined : windows[hit];
		return w !== undefined && timeNs <= w.endNs ? w : undefined;
	}

	return {
		add(sample) {
			if (opts.pid !== undefined && sample.pid !== undefined && sample.pid !== opts.pid) return;
			sampleCount++;
			totalNs += sample.weightNs;
			const thread = normaliseThread(sample.thread);
			bump(threads, thread);
			const dom = dominantFrame(sample.frames);
			if (dom === undefined) systemSamples++;
			else {
				const key = `${thread}\u0000${dom.frame.name}`;
				const row = hot.get(key);
				if (row === undefined)
					hot.set(key, {
						thread,
						frame: dom.frame.name,
						binary: dom.frame.binary,
						cls: dom.cls,
						samples: 1,
						ns: sample.weightNs,
					});
				else {
					row.samples++;
					row.ns += sample.weightNs;
				}
			}
			if (thread === "Main Thread" && windows.length > 0) {
				const w = windowAt(sample.timeNs);
				const bucket = w === undefined ? undefined : buckets.get(w.id);
				if (bucket !== undefined) {
					bucket.samples++;
					bump(bucket.functions, dom?.frame.name ?? sample.frames[0]?.name ?? "?");
					const chain = chainOf(sample.frames);
					if (chain !== "") bump(bucket.chains, chain);
				}
			}
		},
		stats: () => ({
			sampleCount,
			totalNs,
			systemSamples,
			hotspots: [...hot.values()],
			threads: [...threads].map(([thread, samples]) => ({ thread, samples })),
			windows: buckets,
		}),
	};
}

const col = (columns: readonly string[], ...names: string[]): number => {
	for (const n of names) {
		const i = columns.indexOf(n);
		if (i !== -1) return i;
	}
	return -1;
};

/** A `time-profile` row as a sample; undefined when the columns it needs are absent. */
export function sampleFromRow(cells: readonly XmlNode[], columns: readonly string[]): NativeSample | undefined {
	const t = col(columns, "time", "sample-time");
	const th = col(columns, "thread");
	const st = col(columns, "stack", "backtrace", "call-stack");
	if (t === -1 || th === -1 || st === -1) return undefined;
	const w = col(columns, "weight");
	const pc = col(columns, "process");
	const threadCell = cells[th];
	const pid = cellPid(pc === -1 ? undefined : cells[pc]) ?? cellPid(threadCell);
	return {
		timeNs: cellNumber(cells[t]) ?? 0,
		thread: cellText(threadCell),
		...(pid === undefined ? {} : { pid }),
		weightNs: (w === -1 ? undefined : cellNumber(cells[w])) ?? 1_000_000,
		frames: cellFrames(cells[st]),
	};
}

export type RawHang = { startNs: number; durationNs: number; kind: string };

/** A `potential-hangs` row. */
export function hangFromRow(cells: readonly XmlNode[], columns: readonly string[]): RawHang | undefined {
	const s = col(columns, "start", "start-time", "time");
	const d = col(columns, "duration");
	if (s === -1 || d === -1) return undefined;
	const k = col(columns, "hang-type", "type", "kind");
	const startNs = cellNumber(cells[s]);
	const durationNs = cellNumber(cells[d]);
	if (startNs === undefined || durationNs === undefined) return undefined;
	return { startNs, durationNs, kind: (k === -1 ? "" : cellText(cells[k])) || "Hang" };
}

export type RawLeak = { type: string; frame: string; bytes: number; count: number };

const LEAK_TYPE = ["type", "object-type", "allocation-type", "leaked-object", "category"];

/** A `leaks` row: type, blamed frame (responsible frame, else first non-system frame of its stack), size and count. */
export function leakFromRow(cells: readonly XmlNode[], columns: readonly string[]): RawLeak | undefined {
	const ty = col(columns, ...LEAK_TYPE);
	if (ty === -1) return undefined;
	const rf = col(columns, "responsible-frame", "frame");
	const sz = col(columns, "size", "leaked-size", "bytes");
	const ct = col(columns, "count", "instances");
	const st = col(columns, "stack", "backtrace");
	const frames = st === -1 ? [] : cellFrames(cells[st]);
	const responsible = rf === -1 ? "" : cellText(cells[rf]);
	const blamed = responsible !== "" ? responsible : (dominantFrame(frames)?.frame.name ?? frames[0]?.name ?? "?");
	return {
		type: cellText(cells[ty]) || "?",
		frame: blamed,
		bytes: (sz === -1 ? undefined : cellNumber(cells[sz])) ?? 0,
		count: (ct === -1 ? undefined : cellNumber(cells[ct])) ?? 1,
	};
}

export type NativeHotspot = {
	thread: string;
	frame: string;
	binary: string;
	samples: number;
	selfPct: number;
	ms: number;
	severity: "critical" | "warn";
};

export type NativeHang = {
	atMs: number;
	durationMs: number;
	kind: string;
	severity: "critical" | "warn" | "info";
	samples: number;
	topFunctions: Array<{ name: string; samples: number }>;
	chains: Array<{ chain: string; samples: number }>;
};

export type NativeLeak = {
	type: string;
	frame: string;
	count: number;
	bytes: number;
	severity: "critical" | "warn" | "info";
};

export type NativeReport = {
	pid?: number;
	traceDurationMs?: number;
	/** host clock at record start: lets other capturers align with `atMs` */
	traceStartWallMs?: number;
	sampleCount: number;
	systemPct: number;
	threads: Array<{ thread: string; pct: number }>;
	hotspots: NativeHotspot[];
	hangs: NativeHang[];
	leaks: NativeLeak[];
	warnings: string[];
};

export const RED_PCT = 15;
export const YELLOW_PCT = 3;
const MAX_HOTSPOTS = 10;
const MAX_HANGS = 10;
const MAX_LEAKS = 10;

const topN = (map: Counter, n: number): Array<[string, number]> =>
	[...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);

export function hangSeverity(durationMs: number): NativeHang["severity"] {
	return durationMs >= 500 ? "critical" : durationMs >= 250 ? "warn" : "info";
}

export function leakSeverity(bytes: number): NativeLeak["severity"] {
	return bytes >= 1024 * 1024 ? "critical" : bytes >= 64 * 1024 ? "warn" : "info";
}

/** Hang windows in sample time, ids stable for `buildReport`. */
export function hangWindows(hangs: readonly RawHang[]): HangWindow[] {
	return hangs.map((h, id) => ({ id, startNs: h.startNs, endNs: h.startNs + h.durationNs }));
}

export type ReportInput = {
	stats: SampleStats;
	hangs: readonly RawHang[];
	leaks: readonly RawLeak[];
	pid?: number;
	traceDurationMs?: number;
	traceStartWallMs?: number;
	warnings?: string[];
};

/** Samples, hangs and leaks into the typed report: hotspots over 3% of samples, hangs with their main-thread stacks, leaks grouped by (type, frame). */
export function buildReport(input: ReportInput): NativeReport {
	const { stats } = input;
	const total = Math.max(1, stats.sampleCount);
	const hotspots = stats.hotspots
		.map((h): NativeHotspot | undefined => {
			const selfPct = (h.samples / total) * 100;
			if (selfPct < YELLOW_PCT) return undefined;
			return {
				thread: h.thread,
				frame: h.frame,
				binary: h.binary,
				samples: h.samples,
				selfPct: Math.round(selfPct * 10) / 10,
				ms: Math.round(h.ns / 1e6),
				severity: selfPct > RED_PCT ? "critical" : "warn",
			};
		})
		.filter((h): h is NativeHotspot => h !== undefined)
		.sort((a, b) => b.selfPct - a.selfPct)
		.slice(0, MAX_HOTSPOTS);

	const hangs = input.hangs
		.map((raw, id): NativeHang => {
			const bucket = stats.windows.get(id);
			const durationMs = Math.round(raw.durationNs / 1e6);
			return {
				atMs: Math.round(raw.startNs / 1e6),
				durationMs,
				kind: raw.kind,
				severity: hangSeverity(durationMs),
				samples: bucket?.samples ?? 0,
				topFunctions: topN(bucket?.functions ?? new Map(), 5).map(([name, samples]) => ({ name, samples })),
				chains: topN(bucket?.chains ?? new Map(), 3).map(([chain, samples]) => ({ chain, samples })),
			};
		})
		.sort((a, b) => b.durationMs - a.durationMs)
		.slice(0, MAX_HANGS);

	const grouped = new Map<string, { type: string; frame: string; count: number; bytes: number }>();
	for (const leak of input.leaks) {
		const key = `${leak.type}\u0000${leak.frame}`;
		const row = grouped.get(key);
		if (row === undefined) grouped.set(key, { ...leak });
		else {
			row.count += leak.count;
			row.bytes += leak.bytes;
		}
	}
	const leaks = [...grouped.values()]
		.sort((a, b) => b.bytes - a.bytes || b.count - a.count)
		.slice(0, MAX_LEAKS)
		.map((l): NativeLeak => ({ ...l, severity: leakSeverity(l.bytes) }));

	return {
		...(input.pid === undefined ? {} : { pid: input.pid }),
		...(input.traceDurationMs === undefined ? {} : { traceDurationMs: input.traceDurationMs }),
		...(input.traceStartWallMs === undefined ? {} : { traceStartWallMs: input.traceStartWallMs }),
		sampleCount: stats.sampleCount,
		systemPct: Math.round((stats.systemSamples / total) * 1000) / 10,
		threads: stats.threads
			.map((t) => ({ thread: t.thread, pct: Math.round((t.samples / total) * 1000) / 10 }))
			.sort((a, b) => b.pct - a.pct)
			.slice(0, 6),
		hotspots,
		hangs,
		leaks,
		warnings: input.warnings ?? [],
	};
}

const kb = (bytes: number): string =>
	bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;

/** Findings in `Finding` form: `native-hotspot`, `hang`, `leak`. */
export function reportFindings(report: NativeReport, traceHint: string): Finding[] {
	const out: Finding[] = [];
	for (const h of report.hotspots) {
		out.push({
			kind: "native-hotspot",
			severity: h.severity,
			costMs: h.ms,
			evidence: `${h.frame} ${h.selfPct}% of samples on ${h.thread} (${h.samples} samples)`,
			fix:
				h.severity === "critical"
					? "most of the CPU goes here: cut the work, cache it, or move it off this thread"
					: "worth a look if the screen feels slow",
			next: [`open ${traceHint}   (Instruments)`],
			thread: h.thread,
			function: h.frame,
			selfPct: h.selfPct,
		});
	}
	for (const h of report.hangs) {
		const top = h.topFunctions.slice(0, 3).map((f) => `${f.name} (${f.samples})`);
		out.push({
			kind: "hang",
			severity: h.severity,
			costMs: h.durationMs,
			evidence: `${h.kind.toLowerCase()} ${h.durationMs}ms on the main thread at +${(h.atMs / 1000).toFixed(1)}s${top.length > 0 ? `; top: ${top.join(", ")}` : ""}`,
			fix:
				h.chains[0] === undefined
					? "move the blocking work off the main thread"
					: `blocked in ${h.chains[0].chain}: move it off the main thread`,
			next: [`open ${traceHint}   (Instruments)`],
			atMs: h.atMs,
		});
	}
	for (const l of report.leaks) {
		out.push({
			kind: "leak",
			severity: l.severity,
			costMs: 0,
			evidence: `${l.count}x ${l.type}, ${kb(l.bytes)}, from ${l.frame}`,
			fix: "break the retain cycle or release the owner (weak/unowned capture, remove the observer)",
			next: [`open ${traceHint}   (Instruments)`],
			type: l.type,
			count: l.count,
		});
	}
	return out;
}

/** The `report.md` section: threads, hotspots, hangs with their stacks, leaks. */
export function reportSection(report: NativeReport): ReportSection {
	const lines: string[] = [];
	lines.push(
		`${report.sampleCount} samples${report.pid === undefined ? "" : ` of pid ${report.pid}`}${report.traceDurationMs === undefined ? "" : ` over ${(report.traceDurationMs / 1000).toFixed(1)}s`}; ${report.systemPct}% in system code only`
	);
	if (report.threads.length > 0)
		lines.push(`threads: ${report.threads.map((t) => `${t.thread} ${t.pct}%`).join(", ")}`);
	if (report.hotspots.length > 0) {
		lines.push("", "hotspots (self time):");
		for (const h of report.hotspots) lines.push(`- ${h.selfPct}% ${h.frame} [${h.thread}] ${h.ms}ms`);
	} else lines.push("", "no frame over 3% of samples");
	if (report.hangs.length > 0) {
		lines.push("", "hangs:");
		for (const h of report.hangs) {
			lines.push(
				`- ${h.durationMs}ms ${h.kind.toLowerCase()} at +${(h.atMs / 1000).toFixed(1)}s (${h.samples} samples)`
			);
			if (h.topFunctions.length > 0)
				lines.push(`  top: ${h.topFunctions.map((f) => `${f.name} (${f.samples})`).join(", ")}`);
			for (const c of h.chains) lines.push(`  chain: ${c.chain} (${c.samples})`);
		}
	}
	if (report.leaks.length > 0) {
		lines.push("", "leaks:");
		for (const l of report.leaks) lines.push(`- ${l.count}x ${l.type} ${kb(l.bytes)} via ${l.frame}`);
	}
	for (const w of report.warnings) lines.push("", `! ${w}`);
	return { title: "Native (iOS, xctrace)", lines };
}
