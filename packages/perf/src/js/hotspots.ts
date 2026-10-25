import type { Finding } from "../shared/findings.types";
import type { ReportSection } from "../shared/render-md";
import type { CallFrame, CpuProfile } from "./cpu-profile";
import type { FrameResolver } from "./symbolicate";

export const DEFAULT_TOP = 15;

/** Hermes' pseudo-frames: not code the app wrote, so they are reported apart from the function tables. */
const ROOT = "(root)";
const IDLE = "(idle)";
const PROGRAM = "(program)";
const GC = "(garbage collector)";

export type HotFunction = {
	name: string;
	/** original file when source-mapped (project-relative if known), else the script url, else `(native)` */
	file: string;
	line: number;
	column: number;
	mapped: boolean;
	/** `node_modules/<pkg>`'s package */
	package?: string;
	selfMs: number;
	totalMs: number;
	/** share of active (non-idle) time */
	selfPct: number;
	totalPct: number;
};

export type PackageShare = { name: string; selfMs: number; selfPct: number };

export type Hotspots = {
	version: 1;
	durationMs: number;
	sampleCount: number;
	samplingIntervalUs?: number;
	/** `__DEV__` of the app, when it could be read */
	dev?: boolean;
	/** host and device wall clocks at `Profiler.start`: aligns the profile with the session's other series */
	anchor?: { hostWallMs: number; deviceWallMs?: number | undefined };
	idleMs: number;
	idlePct: number;
	/** native time outside JS (`(program)`) */
	programMs: number;
	gcMs: number;
	/** non-idle time: the denominator of every `…Pct` below */
	activeMs: number;
	topSelf: HotFunction[];
	topTotal: HotFunction[];
	/** self time per `node_modules` package, largest first */
	packages: PackageShare[];
	/** share of active JS self time in frames no source map covered */
	unmappedPct: number;
	warnings: string[];
};

/** `node_modules/a/node_modules/@s/b/x.js` → `@s/b` (the innermost package). */
export function packageOf(path: string): string | undefined {
	const match = /.*node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path);
	return match?.[1];
}

type Resolved = { key: string; fn: Omit<HotFunction, "selfMs" | "totalMs" | "selfPct" | "totalPct"> };

function resolveNode(frame: CallFrame, resolve: FrameResolver): Resolved {
	const at = resolve(frame);
	const mapped = at.source !== undefined;
	const name = at.name || frame.functionName || "(anonymous)";
	const file = at.source ?? (frame.url === "" ? "(native)" : frame.url);
	const pkg = packageOf(file);
	return {
		key: `${file}:${at.line}:${at.column}:${name}`,
		fn: { name, file, line: at.line, column: at.column, mapped, ...(pkg === undefined ? {} : { package: pkg }) },
	};
}

/** Time each sample stands for: the delta to the next sample (the last one reuses its own). */
function sampleMs(timeDeltas: readonly number[], index: number, count: number): number {
	const next = index + 1 < count ? timeDeltas[index + 1] : timeDeltas[index];
	return Math.max(0, next ?? 0) / 1000;
}

type Accumulator = {
	functions: Map<string, HotFunction>;
	idleMs: number;
	programMs: number;
	gcMs: number;
	totalMs: number;
};

/** Resolves nodes lazily and answers which are Hermes pseudo-frames. */
function nodeIndex(profile: CpuProfile, resolve: FrameResolver) {
	const parent = new Map<number, number>();
	const byId = new Map<number, CpuProfile["nodes"][number]>();
	for (const node of profile.nodes) {
		byId.set(node.id, node);
		for (const child of node.children ?? []) parent.set(child, node.id);
	}
	const resolved = new Map<number, Resolved | "special">();
	const specialName = (id: number): string | undefined => {
		const name = byId.get(id)?.callFrame.functionName;
		return name === ROOT || name === IDLE || name === PROGRAM || name === GC ? name : undefined;
	};
	const resolvedOf = (id: number): Resolved | "special" | undefined => {
		const hit = resolved.get(id);
		if (hit !== undefined) return hit;
		const node = byId.get(id);
		if (node === undefined) return undefined;
		const next = specialName(id) !== undefined ? "special" : resolveNode(node.callFrame, resolve);
		resolved.set(id, next);
		return next;
	};
	return { parent, specialName, resolvedOf };
}

function touch(acc: Accumulator, r: Resolved): HotFunction {
	const known = acc.functions.get(r.key);
	if (known) return known;
	const created: HotFunction = { ...r.fn, selfMs: 0, totalMs: 0, selfPct: 0, totalPct: 0 };
	acc.functions.set(r.key, created);
	return created;
}

/** Credit `ms` to every distinct function on the stack ending at `leaf` (self only to the leaf's own). */
function addStack(acc: Accumulator, index: ReturnType<typeof nodeIndex>, leaf: number, ms: number): void {
	const seen = new Set<string>();
	for (let id: number | undefined = leaf; id !== undefined; id = index.parent.get(id)) {
		const r = index.resolvedOf(id);
		if (r === undefined || r === "special" || seen.has(r.key)) continue;
		seen.add(r.key);
		const fn = touch(acc, r);
		fn.totalMs += ms;
		if (id === leaf) fn.selfMs += ms;
	}
}

function addSamples(acc: Accumulator, profile: CpuProfile, index: ReturnType<typeof nodeIndex>): void {
	const count = profile.samples.length;
	for (let i = 0; i < count; i++) {
		const leaf = profile.samples[i];
		if (leaf === undefined) continue;
		const ms = sampleMs(profile.timeDeltas, i, count);
		acc.totalMs += ms;
		const leafName = index.specialName(leaf);
		if (leafName === IDLE) acc.idleMs += ms;
		else if (leafName === PROGRAM) acc.programMs += ms;
		else if (leafName === GC) acc.gcMs += ms;
		addStack(acc, index, leaf, ms);
	}
}

/** A profile with no `samples` array: per-node hit counts at the sampling interval. */
function addHitCounts(acc: Accumulator, profile: CpuProfile, index: ReturnType<typeof nodeIndex>, intervalUs: number) {
	const intervalMs = intervalUs / 1000;
	for (const node of profile.nodes) {
		const r = index.resolvedOf(node.id);
		const ms = (node.hitCount ?? 0) * intervalMs;
		acc.totalMs += ms;
		if (r === undefined || r === "special") {
			if (node.callFrame.functionName === IDLE) acc.idleMs += ms;
			continue;
		}
		const fn = touch(acc, r);
		fn.selfMs += ms;
		fn.totalMs += ms;
	}
}

function packageShares(all: readonly HotFunction[], pct: (ms: number) => number, top: number) {
	const perPackage = new Map<string, number>();
	let unmappedMs = 0;
	let jsSelfMs = 0;
	for (const f of all) {
		jsSelfMs += f.selfMs;
		if (!f.mapped && f.file !== "(native)") unmappedMs += f.selfMs;
		if (f.package !== undefined) perPackage.set(f.package, (perPackage.get(f.package) ?? 0) + f.selfMs);
	}
	const packages: PackageShare[] = [...perPackage]
		.map(([name, selfMs]) => ({ name, selfMs: round1(selfMs), selfPct: pct(selfMs) }))
		.sort((a, b) => b.selfMs - a.selfMs)
		.slice(0, top);
	return { packages, unmappedPct: jsSelfMs > 0 ? Math.round((unmappedMs / jsSelfMs) * 1000) / 10 : 0 };
}

/**
 * Self and total time per function from a `.cpuprofile`. `resolve` maps a frame to its original position (identity
 * when unmapped). Self time is the samples whose leaf is the function; total is the samples with it anywhere on the
 * stack (counted once per sample, so recursion does not double). Idle, program and GC are separated.
 */
export function analyzeProfile(
	profile: CpuProfile,
	resolve: FrameResolver,
	options: {
		top?: number;
		dev?: boolean;
		samplingIntervalUs?: number;
		anchor?: Hotspots["anchor"];
		warnings?: string[];
	} = {}
): Hotspots {
	const top = options.top ?? DEFAULT_TOP;
	const index = nodeIndex(profile, resolve);
	const acc: Accumulator = { functions: new Map(), idleMs: 0, programMs: 0, gcMs: 0, totalMs: 0 };
	if (profile.samples.length > 0) addSamples(acc, profile, index);
	else addHitCounts(acc, profile, index, options.samplingIntervalUs ?? 100);

	const activeMs = Math.max(0, acc.totalMs - acc.idleMs);
	const pct = (ms: number): number => (activeMs > 0 ? Math.round((ms / activeMs) * 1000) / 10 : 0);
	const all = [...acc.functions.values()].map((f) => ({
		...f,
		selfMs: round1(f.selfMs),
		totalMs: round1(f.totalMs),
		selfPct: pct(f.selfMs),
		totalPct: pct(f.totalMs),
	}));
	const topSelf = all
		.filter((f) => f.selfMs > 0)
		.sort((a, b) => b.selfMs - a.selfMs)
		.slice(0, top);
	const topTotal = [...all].sort((a, b) => b.totalMs - a.totalMs).slice(0, top);
	const { packages, unmappedPct } = packageShares(all, pct, top);
	return {
		version: 1,
		durationMs: Math.round(acc.totalMs),
		sampleCount: profile.samples.length,
		...(options.samplingIntervalUs === undefined ? {} : { samplingIntervalUs: options.samplingIntervalUs }),
		...(options.dev === undefined ? {} : { dev: options.dev }),
		...(options.anchor === undefined ? {} : { anchor: options.anchor }),
		idleMs: round1(acc.idleMs),
		idlePct: acc.totalMs > 0 ? Math.round((acc.idleMs / acc.totalMs) * 1000) / 10 : 0,
		programMs: round1(acc.programMs),
		gcMs: round1(acc.gcMs),
		activeMs: round1(activeMs),
		topSelf,
		topTotal,
		packages,
		unmappedPct,
		warnings: options.warnings ?? [],
	};
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

const at = (f: HotFunction): string => `${f.file}:${f.line}`;

/** Functions that eat a real share of the active time, worst first (at most 5): `js-hotspot` findings. */
export function hotspotFindings(hotspots: Hotspots): Finding[] {
	return hotspots.topSelf
		.filter((f) => f.selfMs >= 50 && f.selfPct >= 10)
		.slice(0, 5)
		.map((f): Finding => {
			const where = f.package === undefined ? at(f) : `${at(f)} (${f.package})`;
			return {
				kind: "js-hotspot",
				severity: f.selfPct >= 40 && f.selfMs >= 200 ? "critical" : "warn",
				costMs: f.selfMs,
				evidence: `${f.name} ${where}: ${f.selfPct}% of active JS time (${f.selfMs}ms self, ${f.totalMs}ms total)`,
				fix:
					f.package === undefined
						? "cut the work on the JS thread here: memoize, batch, or move it off the interaction path"
						: `${f.package} dominates: check how often the app calls it, or swap it for something lighter`,
				next: ["warden perf js --duration 10s"],
				file: f.file,
				line: f.line,
			};
		});
}

const row = (rank: number, f: HotFunction, ms: number, pct: number): string =>
	`${String(rank).padStart(2)}. ${ms}ms ${pct}%  ${f.name}  ${at(f)}`;

/** The markdown section for `report.md` / text output. */
export function hotspotsSection(hotspots: Hotspots): ReportSection {
	const h = hotspots;
	const lines = [
		`${h.sampleCount} samples over ${(h.durationMs / 1000).toFixed(1)}s · idle ${h.idlePct}% · native ${h.programMs}ms · gc ${h.gcMs}ms`,
		"",
		"top self time (share of active time):",
		...h.topSelf.map((f, i) => row(i + 1, f, f.selfMs, f.selfPct)),
		"",
		"top total time:",
		...h.topTotal.map((f, i) => row(i + 1, f, f.totalMs, f.totalPct)),
	];
	if (h.packages.length > 0) {
		lines.push("", "node_modules by self time:", ...h.packages.map((p) => `  ${p.name}  ${p.selfMs}ms ${p.selfPct}%`));
	}
	if (h.unmappedPct > 0)
		lines.push("", `${h.unmappedPct}% of JS self time is not source-mapped (positions are bundle lines)`);
	for (const w of h.warnings) lines.push(`warning: ${w}`);
	return { title: "JS CPU hotspots", lines };
}
