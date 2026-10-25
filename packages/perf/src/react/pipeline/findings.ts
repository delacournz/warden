import type { Finding } from "../../shared/findings.types";
import { type Commit, causeOf } from "../react.types";
import { type HotCommit, hotCommits } from "./hot-commits";
import { rankComponents } from "./rank";
import type { ComponentStat } from "./reduce";
import {
	CASCADE_MIN_CONSUMERS,
	CHAIN_GAP_MS,
	CHAIN_MIN_COMMITS,
	EAGER_MIN_COST_MS,
	EAGER_MIN_FIBERS,
	FRAME_BUDGET_MS,
	HOT_COMMIT_MS,
	MIN_FINDING_COST_MS,
	MIN_RENDER_SHARE,
	STORM_COMMITS,
	STORM_WINDOW_MS,
} from "./thresholds";

export type FindingOptions = {
	sessionId?: string;
	/** `file:line` for a component, when known; appended to the evidence */
	locate?: (name: string) => string | undefined;
};

type Ctx = { commits: readonly Commit[]; stats: readonly ComponentStat[]; totalMs: number; opts: FindingOptions };

const ms = (n: number) => `${Math.round(n)}ms`;
const at = (ctx: Ctx, name: string) => {
	const where = ctx.opts.locate?.(name);
	return where === undefined ? "" : ` (${where})`;
};
const nextFor = (ctx: Ctx, extra: string[] = []) => [
	...(ctx.opts.sessionId === undefined ? [] : [`warden perf query ${ctx.opts.sessionId} commits --by component`]),
	...extra,
];
const worthy = (ctx: Ctx, costMs: number) =>
	costMs >= MIN_FINDING_COST_MS && (ctx.totalMs <= 0 || costMs / ctx.totalMs >= MIN_RENDER_SHARE);

function slowCommits(ctx: Ctx): Finding[] {
	const hot = hotCommits(ctx.commits);
	const picked = [
		...hot.filter((h) => h.tier === "hot").slice(0, 5),
		...hot.filter((h) => h.tier === "warm").slice(0, 3),
	];
	return picked.map((h: HotCommit): Finding => {
		const top = h.top.map((t) => `${t.name}${t.count > 1 ? `×${t.count}` : ""}`).join(", ");
		const mounting = h.mountCount > 0 && h.mountCount >= h.top.reduce((n, t) => n + t.count, 0) / 2;
		const lead = h.top[0]?.name ?? "the slowest component";
		return {
			kind: "slow-commit",
			severity: h.tier === "hot" ? "critical" : "warn",
			costMs: h.durationMs,
			commitIndex: h.index,
			evidence: `commit #${h.index} took ${ms(h.durationMs)} at ${(h.startMs / 1000).toFixed(1)}s (budget ${FRAME_BUDGET_MS}ms): ${top}`,
			fix: mounting
				? "mount less in one commit: defer off-screen subtrees, window long lists"
				: `cut the work in ${lead}: memoize it, or stop it re-rendering with every update`,
			next: nextFor(ctx, [`warden perf react --duration 10s   (re-measure after the change)`]),
		};
	});
}

function slowRenders(ctx: Ctx): Finding[] {
	const out: Finding[] = [];
	for (const s of rankComponents(ctx.stats)) {
		if ((s.tag !== undefined || s.compiler) && s.maxSelfMs < HOT_COMMIT_MS) continue;
		const share = ctx.totalMs > 0 ? s.sumSelfMs / ctx.totalMs : 0;
		if (!worthy(ctx, s.sumSelfMs) || (s.maxSelfMs < FRAME_BUDGET_MS && share < 0.1)) continue;
		out.push({
			kind: "slow-render",
			severity: s.maxSelfMs >= HOT_COMMIT_MS || share >= 0.25 ? "critical" : "warn",
			costMs: s.sumSelfMs,
			component: s.name,
			evidence: `${s.name}${at(ctx, s.name)}: ${s.renders} renders, ${ms(s.sumSelfMs)} self (max ${ms(s.maxSelfMs)}, mean ${ms(s.meanSelfMs)}), ${Math.round(share * 100)}% of render time`,
			fix: "move heavy work out of render (useMemo, precompute, virtualize) or split the component so less of it re-renders",
			next: nextFor(ctx),
		});
	}
	return out;
}

function topKeys(counts: Record<string, number>, limit = 3): string[] {
	return Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([k]) => k);
}

function memoDefeated(ctx: Ctx): Finding[] {
	const out: Finding[] = [];
	for (const s of ctx.stats) {
		const updates = s.renders - s.mounts;
		if (!s.memo || s.compiler || s.tag !== undefined || updates < 3) continue;
		if (s.causes.props < updates * 0.7 || !worthy(ctx, s.sumSelfMs)) continue;
		const keys = topKeys(s.propKeys);
		out.push({
			kind: "memo-defeated",
			severity: "warn",
			costMs: s.sumSelfMs,
			component: s.name,
			evidence: `${s.name}${at(ctx, s.name)} is memoized but re-rendered ${updates}× because props changed identity (${keys.join(", ")}): ${ms(s.sumSelfMs)} self`,
			fix: `give ${keys.join(", ")} a stable identity: useCallback / useMemo in the parent, hoist constant objects and styles out of render`,
			next: nextFor(ctx),
		});
	}
	return out;
}

function parentCascades(ctx: Ctx): Finding[] {
	const out: Finding[] = [];
	for (const s of ctx.stats) {
		if (s.compiler || s.tag !== undefined || s.causes.parent < 3 || s.causes.parent < s.renders * 0.6) continue;
		const cost = s.sumSelfMs * (s.causes.parent / s.renders);
		if (!worthy(ctx, cost)) continue;
		const parent = topKeys(s.parents, 1)[0];
		out.push({
			kind: "parent-cascade",
			severity: "warn",
			costMs: cost,
			component: s.name,
			evidence: `${s.name}${at(ctx, s.name)} re-rendered ${s.causes.parent}× of ${s.renders} with no changed props, state or context${parent === undefined ? "" : `: each time its parent ${parent} rendered`} (${ms(cost)})`,
			fix: `wrap ${s.name} in React.memo (props are stable), or enable React Compiler, or move the parent's changing state down so it stops re-rendering the subtree`,
			next: nextFor(ctx),
		});
	}
	return out;
}

function contextCascades(ctx: Ctx): Finding[] {
	type Group = { commits: Set<number>; consumers: Record<string, number>; cost: number; hot: boolean };
	const groups = new Map<string, Group>();
	for (const c of ctx.commits) {
		const consumers = c.fibers.filter((f) => causeOf(f) === "context");
		if (consumers.length < CASCADE_MIN_CONSUMERS) continue;
		const key = c.updaters[0] ?? "(unknown provider)";
		const g = groups.get(key) ?? { commits: new Set<number>(), consumers: {}, cost: 0, hot: false };
		g.commits.add(c.index);
		for (const f of consumers) {
			g.consumers[f.name] = (g.consumers[f.name] ?? 0) + 1;
			g.cost += f.selfMs;
		}
		g.hot ||= c.durationMs > HOT_COMMIT_MS;
		groups.set(key, g);
	}
	const out: Finding[] = [];
	for (const [provider, g] of groups) {
		if (!worthy(ctx, g.cost)) continue;
		const total = Object.values(g.consumers).reduce((a, b) => a + b, 0);
		out.push({
			kind: "context-cascade",
			severity: g.hot ? "critical" : "warn",
			costMs: g.cost,
			component: provider,
			evidence: `${provider}${at(ctx, provider)} changed context in ${g.commits.size} commits and re-rendered ${total} consumers (${topKeys(g.consumers).join(", ")}): ${ms(g.cost)}`,
			fix: "split the context so consumers subscribe to what they read, memoize the provider value, or move volatile state out of context",
			next: nextFor(ctx),
		});
	}
	return out;
}

/** Names that scheduled the commit: the reported updaters, else the components whose own state or hooks changed. */
function triggers(c: Commit): Set<string> {
	if (c.updaters.length > 0) return new Set(c.updaters);
	return new Set(c.fibers.filter((f) => causeOf(f) === "state").map((f) => f.name));
}

type Chain = { from: number; to: number };

/** Runs of back-to-back commits where each is a state update by a component the previous commit rendered, after effects ran. */
function chains(commits: readonly Commit[]): Chain[] {
	const found: Chain[] = [];
	let start = 0;
	const linked = (prev: Commit, next: Commit) => {
		if (prev.passiveEffectMs <= 0 && prev.effectMs <= 0) return false;
		if (next.startMs - (prev.startMs + prev.durationMs) > CHAIN_GAP_MS) return false;
		const rendered = new Set(prev.fibers.map((f) => f.name));
		for (const t of triggers(next)) if (rendered.has(t)) return true;
		return false;
	};
	for (let i = 1; i <= commits.length; i++) {
		const prev = commits[i - 1];
		const next = commits[i];
		if (next !== undefined && prev !== undefined && linked(prev, next)) continue;
		if (i - start >= CHAIN_MIN_COMMITS) found.push({ from: start, to: i - 1 });
		start = i;
	}
	return found;
}

function effectChains(ctx: Ctx, found: Chain[]): Finding[] {
	const out: Finding[] = [];
	for (const { from, to } of found) {
		const run = ctx.commits.slice(from, to + 1);
		const cost = run.slice(1).reduce((n, c) => n + c.durationMs, 0);
		if (cost < MIN_FINDING_COST_MS) continue;
		const counts: Record<string, number> = {};
		for (const c of run.slice(1)) for (const t of triggers(c)) counts[t] = (counts[t] ?? 0) + 1;
		const component = topKeys(counts, 1)[0] ?? "(unknown)";
		out.push({
			kind: "effect-chain",
			severity: cost >= HOT_COMMIT_MS ? "critical" : "warn",
			costMs: cost,
			component,
			evidence: `${run.length} back-to-back commits (#${run[0]?.index}-#${run.at(-1)?.index}, ${ms(cost)} after the first): ${component}${at(ctx, component)} sets state from an effect, which renders, which runs the effect again`,
			fix: "compute the value during render (useMemo) instead of useEffect + setState, or batch the updates into one",
			next: nextFor(ctx),
		});
	}
	return out;
}

/** Runs of at least `STORM_COMMITS` commits starting within `STORM_WINDOW_MS` of the run's first, greedily and without overlap. */
function stormRuns(live: readonly Commit[]): Commit[][] {
	const runs: Commit[][] = [];
	let i = 0;
	while (i < live.length) {
		let j = i;
		while (j + 1 < live.length && (live[j + 1]?.startMs ?? 0) - (live[i]?.startMs ?? 0) <= STORM_WINDOW_MS) j++;
		if (j - i + 1 >= STORM_COMMITS) {
			runs.push(live.slice(i, j + 1));
			i = j + 1;
		} else {
			i++;
		}
	}
	return runs;
}

function stormFinding(ctx: Ctx, run: readonly Commit[]): Finding | undefined {
	const cost = run.reduce((n, c) => n + c.durationMs, 0);
	if (cost < MIN_FINDING_COST_MS) return undefined;
	const counts: Record<string, number> = {};
	for (const c of run) for (const f of c.fibers) counts[f.name] = (counts[f.name] ?? 0) + 1;
	const top = topKeys(counts, 3);
	const tagged = top.every((name) => ctx.stats.find((s) => s.name === name)?.tag === "animated");
	return {
		kind: "render-storm",
		severity: tagged ? "info" : cost >= 300 ? "critical" : "warn",
		costMs: cost,
		component: top[0] ?? "(unknown)",
		renders: run.length,
		evidence: `${run.length} commits in ${ms((run.at(-1)?.startMs ?? 0) - (run[0]?.startMs ?? 0))} (${ms(cost)} total), mostly ${top.join(", ")}${tagged ? ": animation-driven, likely intended" : ""}`,
		fix: tagged
			? "if it is not meant to animate, stop the timer or state update driving it; otherwise drive it with Reanimated shared values off the JS thread"
			: "batch the updates (one setState, startTransition) or throttle the source (scroll, timer, socket) so React commits once per frame",
		next: nextFor(ctx),
	};
}

function renderStorms(ctx: Ctx, skip: Set<number>): Finding[] {
	const runs = stormRuns(ctx.commits.filter((c) => !skip.has(c.index)));
	return runs.flatMap((run) => stormFinding(ctx, run) ?? []);
}

type MountCandidate = {
	name: string;
	/** mounted fibers in the subtree under it (itself included) */
	fibers: number;
	/** of those, how many carry its own name */
	own: number;
	costMs: number;
	parent: string | undefined;
	commit: number;
};

/** A subtree this large and costly: a first-mount of this size is what an eager mount looks like. */
const isEager = (m: MountCandidate) => m.fibers >= EAGER_MIN_FIBERS && m.costMs >= EAGER_MIN_COST_MS;

/**
 * The subtrees a commit mounted that are worth deferring. From each top-level mount, follow the dominant child (half
 * the subtree or more) down to where the weight stops concentrating, and stop above a list of repeated leaf items.
 * The app's own root is never a finding: it cannot be deferred.
 */
function mountCandidates(c: Commit): MountCandidate[] {
	const mounted = c.fibers.filter((f) => f.causes?.firstMount === true);
	if (mounted.length < EAGER_MIN_FIBERS) return [];
	const names = new Set(mounted.map((f) => f.name));
	const parentOf = new Map<string, string | undefined>();
	for (const f of c.fibers) if (!parentOf.has(f.name)) parentOf.set(f.name, f.parent);
	const stat = new Map<string, MountCandidate>();
	for (const f of mounted) {
		let name: string | undefined = f.name;
		for (let depth = 0; name !== undefined && names.has(name) && depth < 64; depth++) {
			const entry = stat.get(name) ?? {
				name,
				fibers: 0,
				own: 0,
				costMs: 0,
				parent: parentOf.get(name),
				commit: c.index,
			};
			entry.fibers += 1;
			entry.costMs += f.selfMs;
			if (depth === 0) entry.own += 1;
			stat.set(name, entry);
			name = parentOf.get(name);
		}
	}
	const eager = [...stat.values()].filter(isEager);
	const pick = (m: MountCandidate, depth: number): MountCandidate | undefined => {
		const dominant = eager
			.filter((o) => o.parent === m.name && o.name !== m.name)
			.sort((a, b) => b.fibers - a.fibers)[0];
		const repeatedItems = dominant !== undefined && dominant.own === dominant.fibers && dominant.fibers >= 10;
		if (dominant !== undefined && dominant.fibers >= m.fibers * 0.5 && !repeatedItems && depth < 64) {
			return pick(dominant, depth + 1);
		}
		return m.parent === undefined ? undefined : m;
	};
	const tops = eager.filter((m) => m.parent === undefined || !eager.some((o) => o.name === m.parent));
	return tops.flatMap((m) => pick(m, 0) ?? []);
}

function eagerMounts(ctx: Ctx): Finding[] {
	const best = new Map<string, MountCandidate>();
	for (const c of ctx.commits) {
		for (const m of mountCandidates(c)) {
			const known = best.get(m.name);
			if (known === undefined || m.costMs > known.costMs) best.set(m.name, m);
		}
	}
	return [...best.values()].map(
		(m): Finding => ({
			kind: "eager-mount",
			severity: m.costMs >= HOT_COMMIT_MS ? "critical" : "warn",
			costMs: m.costMs,
			component: m.name,
			evidence: `${m.name}${at(ctx, m.name)} mounted ${m.fibers} components (${ms(m.costMs)} self) in commit #${m.commit}; if it is not on screen yet, that work blocks the first frame`,
			fix: `defer ${m.name} until it is visible: lazy tab/route, Suspense + React.lazy, InteractionManager, or FlatList initialNumToRender / windowSize`,
			next: nextFor(ctx),
		})
	);
}

/** Every finding the commits support, unranked (the report ranks by severity, then cost). */
export function reactFindings(
	commits: readonly Commit[],
	stats: readonly ComponentStat[],
	totalMs: number,
	opts: FindingOptions = {}
): Finding[] {
	const ctx: Ctx = { commits, stats, totalMs, opts };
	const found = chains(commits);
	const inChain = new Set(found.flatMap(({ from, to }) => commits.slice(from, to + 1).map((c) => c.index)));
	return [
		...slowCommits(ctx),
		...eagerMounts(ctx),
		...effectChains(ctx, found),
		...renderStorms(ctx, inChain),
		...contextCascades(ctx),
		...memoDefeated(ctx),
		...parentCascades(ctx),
		...slowRenders(ctx),
	];
}
