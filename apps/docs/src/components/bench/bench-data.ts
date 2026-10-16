import type { BenchSummary, SummaryFramework } from "@delacour/warden-e2e-bench/src/report/summary";

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

const PLATFORM_ORDER: Record<string, number> = { ios: 0, android: 1 };

/** Every committed summary in `content/docs/bench/data/`, platforms in order, newest date first. */
export const SUMMARIES: readonly BenchSummary[] = Object.values(modules)
	.filter(isSummary)
	.sort(
		(a, b) => (PLATFORM_ORDER[a.platform] ?? 9) - (PLATFORM_ORDER[b.platform] ?? 9) || b.date.localeCompare(a.date)
	);

export const isOk = (f: SummaryFramework): f is OkFramework => f.status === "ok";

export const PLATFORM_LABEL: Record<string, string> = { ios: "iOS", android: "Android" };

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
