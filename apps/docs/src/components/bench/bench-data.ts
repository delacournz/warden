import type { BenchSummary, SummaryFramework } from "@delacour/warden-e2e-bench/src/report/summary";
import { orderSummaries } from "./bench-order";

export type { BenchSummary, SummaryFramework };
export type OkFramework = Extract<SummaryFramework, { status: "ok" }>;

const SUPPORTED_VERSION = 1;

const modules = import.meta.glob<unknown>("../../../content/docs/bench/data/*.json", {
	eager: true,
	import: "default",
});

const isSummary = (value: unknown): value is BenchSummary =>
	typeof value === "object" &&
	value !== null &&
	"summaryVersion" in value &&
	value.summaryVersion === SUPPORTED_VERSION &&
	"frameworks" in value &&
	Array.isArray(value.frameworks);

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/, "");

const ENTRIES = orderSummaries(
	Object.entries(modules).flatMap(([path, value]) =>
		isSummary(value) ? [{ slug: basename(path), summary: value }] : []
	)
);

/** Every committed summary in `content/docs/bench/data/`, platforms in order, newest run first. */
export const SUMMARIES: readonly BenchSummary[] = ENTRIES.map((e) => e.summary);

const SLUGS = new Map(ENTRIES.map((e) => [e.summary.runId, e.slug]));

/** The data file's basename, which is also the full report's: `docs/bench/<slug>.md`. */
export const reportSlug = (s: BenchSummary): string => SLUGS.get(s.runId) ?? `${s.platform}-${s.date}`;

export const isOk = (f: SummaryFramework): f is OkFramework => f.status === "ok";

export const PLATFORM_LABEL: Record<string, string> = { ios: "iOS", android: "Android" };

/** Labels only: the framework list always comes from the dataset, so published runs that still carry `maestro` / `detox` rows keep rendering. */
export const FRAMEWORK_LABEL: Record<string, string> = {
	warden: "warden",
	maestro: "Maestro",
	argent: "Argent",
	"agent-device": "agent-device",
	"tester-army": "tester.army",
	detox: "Detox",
};

export const label = (fw: string): string => FRAMEWORK_LABEL[fw] ?? fw;

/** Frameworks that passed every test in every rep: only these can be called fastest. */
export const cleanFrameworks = (s: BenchSummary): OkFramework[] => s.frameworks.filter(isOk).filter((f) => !f.failing);
