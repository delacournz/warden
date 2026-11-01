import type { Finding } from "../shared/findings.types";
import { DEV_BUILD_BANNER, type ReportSection } from "../shared/render-md";
import { type CpuIndex, cpuCorrelator, type FrameLabel, type HotCommitWithCpu } from "./pipeline/cpu-correlate";
import { type FindingOptions, reactFindings } from "./pipeline/findings";
import { hotCommits } from "./pipeline/hot-commits";
import { componentRanker } from "./pipeline/rank";
import { type ComponentStat, componentReducer } from "./pipeline/reduce";
import { componentTagger } from "./pipeline/tag";
import type { CommitsFile } from "./react.types";

export type ComponentSource = { file: string; line: number };

export type AnalyzeOptions = {
	sessionId?: string;
	/** where a component is declared: the runtime's report first, then a grep of the project */
	locate?: (name: string) => ComponentSource | undefined;
	cpu?: { index: CpuIndex; label: FrameLabel };
};

export type RankedComponent = Omit<ComponentStat, "commits"> & { commits: number; source?: ComponentSource };

/** `react/findings.json`. */
export type ReactAnalysis = {
	version: 1;
	dev?: boolean;
	totals: { commits: number; renderMs: number; warm: number; hot: number; components: number; durationMs: number };
	hotCommits: HotCommitWithCpu[];
	components: RankedComponent[];
	findings: Finding[];
	warnings: string[];
};

export class ReactAnalyzer {
	private whereOf(s: ComponentSource | undefined) {
		return s === undefined ? undefined : `${s.file}:${s.line}`;
	}

	/** Hot commits, ranked components and findings for one recording. Pure. */
	analyzeReact(file: CommitsFile, options: AnalyzeOptions = {}): ReactAnalysis {
		const { commits } = file;
		const totalMs = componentReducer.totalRenderMs(commits);
		const stats = componentTagger.tagComponents(componentReducer.reduceComponents(commits));
		const findingOptions: FindingOptions = {
			...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
			...(options.locate === undefined ? {} : { locate: (name) => this.whereOf(options.locate?.(name)) }),
		};
		const hot = hotCommits.find(commits);
		const withCpu: HotCommitWithCpu[] =
			options.cpu === undefined
				? hot.map((h) => ({ ...h, cpu: [] }))
				: cpuCorrelator.correlateCpu(hot, options.cpu.index, options.cpu.label);
		const tiers = commits.map((c) => hotCommits.tierOf(c.durationMs));
		return {
			version: 1,
			...(file.dev === undefined ? {} : { dev: file.dev }),
			totals: {
				commits: commits.length,
				renderMs: totalMs,
				warm: tiers.filter((t) => t === "warm").length,
				hot: tiers.filter((t) => t === "hot").length,
				components: stats.length,
				durationMs: file.anchor.stoppedWallMs - file.anchor.startedWallMs,
			},
			hotCommits: withCpu,
			components: componentRanker
				.rankComponents(stats)
				.slice(0, 25)
				.map(({ commits: seen, ...s }) => {
					const source = options.locate?.(s.name);
					return { ...s, commits: seen.length, ...(source === undefined ? {} : { source }) };
				}),
			findings: reactFindings.find(commits, stats, totalMs, findingOptions),
			warnings: file.warnings,
		};
	}

	private ms(n: number) {
		return `${Math.round(n)}ms`;
	}

	private commitLines(analysis: ReactAnalysis, limit: number): string[] {
		if (analysis.hotCommits.length === 0) return [];
		const lines = ["", "hot commits (slowest first):"];
		for (const h of analysis.hotCommits.slice(0, limit)) {
			const top = h.top.map((c) => `${c.name}${c.count > 1 ? `×${c.count}` : ""}`).join(", ");
			const heat = "█".repeat(Math.max(1, Math.round(h.heat * 5)));
			lines.push(`- #${h.index} @${(h.startMs / 1000).toFixed(1)}s ${this.ms(h.durationMs)} ${h.tier} ${heat} ${top}`);
			if (h.cpu.length > 0) {
				const cpu = h.cpu.map(
					(f) => `${f.name}${f.file === undefined ? "" : ` ${f.file}:${f.line ?? 0}`} ${this.ms(f.selfMs)}`
				);
				lines.push(`  js: ${cpu.join("; ")}`);
			}
		}
		if (analysis.hotCommits.length > limit) {
			lines.push(`  ... ${analysis.hotCommits.length - limit} more in react/findings.json`);
		}
		return lines;
	}

	private componentLines(analysis: ReactAnalysis, limit: number): string[] {
		if (analysis.components.length === 0) return [];
		const lines = ["", "components (by self time):"];
		for (const c of analysis.components.slice(0, limit)) {
			const where = c.source === undefined ? "" : ` ${c.source.file}:${c.source.line}`;
			const tag = c.tag === undefined ? "" : ` [${c.tag}]`;
			lines.push(
				`- ${c.name}${tag} n=${c.renders} sum=${this.ms(c.sumSelfMs)} max=${this.ms(c.maxSelfMs)} mean=${this.ms(c.meanSelfMs)}${where}`
			);
		}
		return lines;
	}

	/** The markdown section: summary, the top hot commits inline (the rest are in `react/findings.json`), top components. */
	reactSection(analysis: ReactAnalysis, limits: { commits?: number; components?: number } = {}): ReportSection {
		const t = analysis.totals;
		return {
			title: "React renders",
			lines: [
				`${t.commits} commits in ${(t.durationMs / 1000).toFixed(1)}s, ${this.ms(t.renderMs)} rendering: ${t.hot} hot (over 50ms), ${t.warm} warm (16-50ms)`,
				...(analysis.dev === true ? [DEV_BUILD_BANNER] : []),
				...this.commitLines(analysis, limits.commits ?? 10),
				...this.componentLines(analysis, limits.components ?? 8),
				...analysis.warnings.flatMap((w) => ["", `warning: ${w}`]),
			],
		};
	}
}

export const reactAnalyzer = new ReactAnalyzer();
