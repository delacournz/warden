import type { CallFrame, CpuProfile } from "../js/cpu-profile";
import { type ComponentStat, reduceComponents } from "../react/pipeline/reduce";
import { type Commit, causeOf } from "../react/react.types";

const round = (n: number, digits = 1): number => Math.round(n * 10 ** digits) / 10 ** digits;

export type ComponentRow = Pick<
	ComponentStat,
	"name" | "renders" | "mounts" | "sumSelfMs" | "maxSelfMs" | "meanSelfMs" | "memo"
> & { commits: number };

/** `commits --by component`: every component's renders and self time, costliest first. */
export function commitsByComponent(commits: readonly Commit[], limit = 15): ComponentRow[] {
	return reduceComponents([...commits])
		.sort((a, b) => b.sumSelfMs - a.sumSelfMs)
		.slice(0, limit)
		.map((s) => ({
			name: s.name,
			renders: s.renders,
			mounts: s.mounts,
			sumSelfMs: round(s.sumSelfMs),
			maxSelfMs: round(s.maxSelfMs),
			meanSelfMs: round(s.meanSelfMs),
			memo: s.memo,
			commits: s.commits.length,
		}));
}

export type WindowRow = {
	fromMs: number;
	toMs: number;
	commits: number;
	renderMs: number;
	worstMs: number;
	top: string[];
};

/** `commits --by window`: commits bucketed into `windowMs` slices of the recording (by `startMs`), busiest first. */
export function commitsByWindow(commits: readonly Commit[], windowMs: number, limit = 15): WindowRow[] {
	const buckets = new Map<number, Commit[]>();
	for (const c of commits) {
		const slot = Math.floor(c.startMs / windowMs);
		buckets.set(slot, [...(buckets.get(slot) ?? []), c]);
	}
	return [...buckets.entries()]
		.map(([slot, list]): WindowRow => {
			const byName = new Map<string, number>();
			for (const c of list) for (const f of c.fibers) byName.set(f.name, (byName.get(f.name) ?? 0) + f.selfMs);
			return {
				fromMs: slot * windowMs,
				toMs: (slot + 1) * windowMs,
				commits: list.length,
				renderMs: round(list.reduce((s, c) => s + c.durationMs, 0)),
				worstMs: round(Math.max(...list.map((c) => c.durationMs))),
				top: [...byName.entries()]
					.sort((a, b) => b[1] - a[1])
					.slice(0, 3)
					.map(([name]) => name),
			};
		})
		.sort((a, b) => b.renderMs - a.renderMs)
		.slice(0, limit);
}

export type CommitRow = {
	index: number;
	startMs: number;
	durationMs: number;
	fibers: number;
	updaters: string[];
	top: Array<{ name: string; selfMs: number; cause: string }>;
};

/** `commits --by index`: the slowest commits, or the one named by `only` with its fibers. */
export function commitsByIndex(
	commits: readonly Commit[],
	options: { only?: number; limit?: number } = {}
): CommitRow[] {
	const picked =
		options.only === undefined
			? [...commits].sort((a, b) => b.durationMs - a.durationMs).slice(0, options.limit ?? 10)
			: commits.filter((c) => c.index === options.only);
	const depth = options.only === undefined ? 3 : 15;
	return picked.map((c) => ({
		index: c.index,
		startMs: round(c.startMs),
		durationMs: round(c.durationMs),
		fibers: c.fibers.length,
		updaters: c.updaters,
		top: [...c.fibers]
			.sort((a, b) => b.selfMs - a.selfMs)
			.slice(0, depth)
			.map((f) => ({ name: f.name, selfMs: round(f.selfMs), cause: causeOf(f) })),
	}));
}

export type CascadeRow = { origin: string; commits: number; fibers: number; cascadeFibers: number; renderMs: number };

/** `commits --by cascade`: per updater, how many fibers re-rendered only because a parent or context changed. */
export function commitsCascade(commits: readonly Commit[], limit = 10): CascadeRow[] {
	const byOrigin = new Map<string, CascadeRow>();
	for (const c of commits) {
		const origin = c.updaters[0] ?? "(unknown)";
		const row = byOrigin.get(origin) ?? { origin, commits: 0, fibers: 0, cascadeFibers: 0, renderMs: 0 };
		row.commits += 1;
		row.fibers += c.fibers.length;
		row.cascadeFibers += c.fibers.filter((f) => ["parent", "context"].includes(causeOf(f))).length;
		row.renderMs += c.durationMs;
		byOrigin.set(origin, row);
	}
	return [...byOrigin.values()]
		.map((r) => ({ ...r, renderMs: round(r.renderMs) }))
		.sort((a, b) => b.cascadeFibers - a.cascadeFibers || b.renderMs - a.renderMs)
		.slice(0, limit);
}

const SKIPPED = new Set(["(root)", "(idle)", "(program)", "(garbage collector)"]);

export type NamedFrame = (frame: CallFrame) => { name: string; file?: string; line?: number };

const keyOf = (n: ReturnType<NamedFrame>): string =>
	`${n.name}${n.file === undefined ? "" : ` ${n.file}:${n.line ?? 0}`}`;

/** Ms each sample stands for. */
function weights(profile: CpuProfile): number[] {
	return profile.samples.map((_, i) => Math.max(0, profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000);
}

export type CpuFnRow = { name: string; selfMs: number; selfPct: number };

/**
 * `cpu --window a-b`: self time per function over the samples between `fromMs` and `toMs` on the session timeline.
 * `profileStartMs` is where the profile began on that timeline.
 */
export function cpuWindow(
	profile: CpuProfile,
	label: NamedFrame,
	window: { fromMs: number; toMs: number; profileStartMs: number },
	limit = 15
): CpuFnRow[] {
	const w = weights(profile);
	const frames = new Map(profile.nodes.map((n) => [n.id, n.callFrame]));
	const self = new Map<string, number>();
	let elapsedUs = 0;
	let active = 0;
	for (let i = 0; i < profile.samples.length; i++) {
		elapsedUs += profile.timeDeltas[i] ?? 0;
		const at = window.profileStartMs + elapsedUs / 1000;
		if (at < window.fromMs || at >= window.toMs) continue;
		const frame = frames.get(profile.samples[i] ?? -1);
		if (frame === undefined || frame.functionName === "(idle)") continue;
		active += w[i] ?? 0;
		if (SKIPPED.has(frame.functionName)) continue;
		const key = keyOf(label(frame));
		self.set(key, (self.get(key) ?? 0) + (w[i] ?? 0));
	}
	return [...self.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([name, selfMs]) => ({
			name,
			selfMs: round(selfMs),
			selfPct: active === 0 ? 0 : round((selfMs / active) * 100),
		}));
}

export type TreeRow = { depth: number; name: string; totalMs: number; selfMs: number; totalPct: number };

/** `cpu --tree`: the call tree top-down by total time, pruned below `minPct` of active time and past `maxDepth`. */
export function cpuTree(
	profile: CpuProfile,
	label: NamedFrame,
	options: { maxDepth?: number; minPct?: number } = {}
): TreeRow[] {
	const maxDepth = options.maxDepth ?? 8;
	const minPct = options.minPct ?? 2;
	const w = weights(profile);
	const selfOf = new Map<number, number>();
	profile.samples.forEach((id, i) => {
		selfOf.set(id, (selfOf.get(id) ?? 0) + (w[i] ?? 0));
	});
	const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
	const totalOf = new Map<number, number>();
	const total = (id: number): number => {
		const cached = totalOf.get(id);
		if (cached !== undefined) return cached;
		const node = nodes.get(id);
		const sum = (selfOf.get(id) ?? 0) + (node?.children ?? []).reduce((s, c) => s + total(c), 0);
		totalOf.set(id, sum);
		return sum;
	};
	const root = profile.nodes[0];
	if (root === undefined) return [];
	const idle = profile.nodes.filter((n) => n.callFrame.functionName === "(idle)").reduce((s, n) => s + total(n.id), 0);
	const active = Math.max(1e-9, total(root.id) - idle);
	const rows: TreeRow[] = [];
	const walk = (id: number, depth: number): void => {
		const node = nodes.get(id);
		if (node === undefined) return;
		const t = total(id);
		const frame = node.callFrame;
		const pct = (t / active) * 100;
		if (depth > 0 && (frame.functionName === "(idle)" || pct < minPct || depth > maxDepth)) return;
		if (frame.functionName !== "(root)") {
			rows.push({
				depth,
				name: keyOf(label(frame)),
				totalMs: round(t),
				selfMs: round(selfOf.get(id) ?? 0),
				totalPct: round(pct),
			});
		}
		for (const c of [...(node.children ?? [])].sort((a, b) => total(b) - total(a))) walk(c, depth + 1);
	};
	walk(root.id, 0);
	return rows;
}

export type CallerRow = { caller: string; ms: number; pct: number };

/** `stacks callers <fn>`: who calls a function, by the time spent in it under each caller. */
export function jsCallers(profile: CpuProfile, label: NamedFrame, fn: string, limit = 10): CallerRow[] {
	const w = weights(profile);
	const selfOf = new Map<number, number>();
	profile.samples.forEach((id, i) => {
		selfOf.set(id, (selfOf.get(id) ?? 0) + (w[i] ?? 0));
	});
	const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
	const parent = new Map<number, number>();
	for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
	const totalOf = new Map<number, number>();
	const total = (id: number): number => {
		const cached = totalOf.get(id);
		if (cached !== undefined) return cached;
		const sum = (selfOf.get(id) ?? 0) + (nodes.get(id)?.children ?? []).reduce((s, c) => s + total(c), 0);
		totalOf.set(id, sum);
		return sum;
	};
	const needle = fn.toLowerCase();
	const byCaller = new Map<string, number>();
	let all = 0;
	for (const n of profile.nodes) {
		const named = label(n.callFrame);
		if (!keyOf(named).toLowerCase().includes(needle) && !named.name.toLowerCase().includes(needle)) continue;
		const p = parent.get(n.id);
		const caller = p === undefined ? "(root)" : keyOf(label(nodes.get(p)?.callFrame ?? n.callFrame));
		const t = total(n.id);
		all += t;
		byCaller.set(caller, (byCaller.get(caller) ?? 0) + t);
	}
	return [...byCaller.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([caller, ms]) => ({ caller, ms: round(ms), pct: all === 0 ? 0 : round((ms / all) * 100) }));
}
