import { type CauseKind, type Commit, type FiberRender, reactCauseClassifier } from "../react.types";

export type ComponentStat = {
	name: string;
	renders: number;
	mounts: number;
	sumActualMs: number;
	sumSelfMs: number;
	maxSelfMs: number;
	maxActualMs: number;
	meanSelfMs: number;
	causes: Record<CauseKind, number>;
	/** changed prop name to the renders it changed in */
	propKeys: Record<string, number>;
	/** parent component name to renders under it */
	parents: Record<string, number>;
	memo: boolean;
	compiler: boolean;
	/** indices of the commits it rendered in */
	commits: number[];
	/** set by `tagComponents` */
	tag?: "animated" | "transition";
};

export class ComponentReducer {
	private zeroCauses(): Record<CauseKind, number> {
		return {
			mount: 0,
			context: 0,
			state: 0,
			props: 0,
			parent: 0,
			unknown: 0,
		};
	}

	private emptyStat(name: string): ComponentStat {
		return {
			name,
			renders: 0,
			mounts: 0,
			sumActualMs: 0,
			sumSelfMs: 0,
			maxSelfMs: 0,
			maxActualMs: 0,
			meanSelfMs: 0,
			causes: this.zeroCauses(),
			propKeys: {},
			parents: {},
			memo: false,
			compiler: false,
			commits: [],
		};
	}

	private addFiber(s: ComponentStat, f: FiberRender): void {
		s.renders += 1;
		const cause = reactCauseClassifier.classify(f);
		s.causes[cause] += 1;
		if (cause === "mount") s.mounts += 1;
		s.sumActualMs += f.actualMs;
		s.sumSelfMs += f.selfMs;
		s.maxSelfMs = Math.max(s.maxSelfMs, f.selfMs);
		s.maxActualMs = Math.max(s.maxActualMs, f.actualMs);
		s.memo ||= f.memo;
		s.compiler ||= f.compiler;
		for (const key of f.causes?.props ?? []) s.propKeys[key] = (s.propKeys[key] ?? 0) + 1;
		if (f.parent !== undefined) s.parents[f.parent] = (s.parents[f.parent] ?? 0) + 1;
	}

	/** One row per component name over every commit: n, sum, max, mean of self time, plus why it rendered. */
	reduceComponents(commits: readonly Commit[]): ComponentStat[] {
		const stats = new Map<string, ComponentStat>();
		for (const commit of commits) {
			const seen = new Set<string>();
			for (const f of commit.fibers) {
				const s = stats.get(f.name) ?? this.emptyStat(f.name);
				stats.set(f.name, s);
				this.addFiber(s, f);
				if (!seen.has(f.name)) {
					seen.add(f.name);
					s.commits.push(commit.index);
				}
			}
		}
		for (const s of stats.values()) s.meanSelfMs = s.renders > 0 ? s.sumSelfMs / s.renders : 0;
		return [...stats.values()];
	}

	/** Total render time: the denominator of every share. */
	totalRenderMs(commits: readonly Commit[]): number {
		return commits.reduce((sum, c) => sum + c.durationMs, 0);
	}
}

export const componentReducer = new ComponentReducer();
