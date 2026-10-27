import { describe, expect, test } from "bun:test";
import { CANONICAL_IDS, type RepResult, type TestResult } from "./schema";
import {
	dist,
	flakeRate,
	frameworkStats,
	median,
	passRate,
	percentile,
	ratio,
	stepGroups,
	stepVerb,
	withRatios,
} from "./stats";

const t = (id: TestResult["id"], ms: number, status: TestResult["status"] = "passed"): TestResult => ({
	id,
	nativeName: id,
	status,
	durationMs: ms,
});

const rep = (index: number, cold: boolean, wallMs: number, first: number, second = 2000): RepResult => ({
	index,
	cold,
	wallMs,
	wallSource: "harness",
	startedAt: "2026-10-16T00:00:00.000Z",
	tests: [t("onboarding/steps-to-sign-in", first), t("sign-in/field-errors", second)],
	rawArtifactDir: `artifacts/x/rep-${index}`,
});

describe("percentile / median / dist", () => {
	test("nearest rank", () => {
		expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
		expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
		expect(Number.isNaN(percentile([], 0.5))).toBe(true);
	});
	test("median averages the middle pair", () => {
		expect(median([4, 1, 3, 2])).toBe(2.5);
		expect(median([3, 1, 2])).toBe(2);
	});
	test("dist", () => {
		const d = dist([10, 20, 30]);
		expect(d).toEqual({ n: 3, median: 20, p95: 30, min: 10, max: 30, stddev: 8.2, cvPct: 40.8 });
		expect(dist([]).n).toBe(0);
	});
	test("ratio", () => {
		expect(ratio(3, 2)).toBe(1.5);
		expect(ratio(3, 0)).toBeUndefined();
		expect(ratio(Number.NaN, 2)).toBeUndefined();
	});
});

describe("rates", () => {
	test("flakeRate is the minority share", () => {
		expect(flakeRate(["passed", "passed", "failed"])).toBe(0.333);
		expect(flakeRate(["passed", "passed"])).toBe(0);
		expect(flakeRate([])).toBe(0);
	});
	test("passRate", () => {
		expect(passRate(["passed", "failed"])).toBe(0.5);
	});
});

describe("frameworkStats", () => {
	const reps = [rep(1, true, 12_000, 5000), rep(2, false, 10_000, 3000), rep(3, false, 11_000, 3200)];
	const stats = frameworkStats({ reps, prepareMs: 1500, teardownMs: 200 });

	test("warm medians exclude the cold rep", () => {
		expect(stats.warmSuiteWall).toMatchObject({ n: 2, median: 10_500, min: 10_000, max: 11_000 });
		expect(stats.coldSuiteWallMs).toBe(12_000);
		expect(stats.perTest["onboarding/steps-to-sign-in"].median).toBe(3100);
	});
	test("overhead, cold start and first-test overhead", () => {
		expect(stats.overheadMs).toBe(median([10_000 - 5000, 11_000 - 5200]));
		expect(stats.coldStartMs).toBe(12_000 - 10_500 + 1500);
		expect(stats.firstTestOverheadMs).toBe(5000 - 3100);
		expect(stats.prepareMs).toBe(1500);
		expect(stats.teardownMs).toBe(200);
	});
	test("missing tests count as missing in rates", () => {
		expect(stats.perTest["todos/add-complete-filter"].n).toBe(0);
		expect(stats.perTest["todos/add-complete-filter"].passRate).toBe(0);
		expect(stats.passRate).toBe(0.25);
	});
	test("a single rep run uses it for medians", () => {
		const one = frameworkStats({ reps: [rep(1, true, 9000, 1000)], prepareMs: 0, teardownMs: 0 });
		expect(one.warmSuiteWall.median).toBe(9000);
		expect(one.coldStartMs).toBeUndefined();
	});
	test("step latency when steps exist", () => {
		const withSteps: RepResult = {
			...rep(2, false, 10_000, 3000),
			tests: [
				{ ...t("onboarding/steps-to-sign-in", 3000), steps: [{ kind: "tap", label: "a", ms: 100, status: "passed" }] },
			],
		};
		expect(frameworkStats({ reps: [withSteps], prepareMs: 0, teardownMs: 0 }).stepLatency?.median).toBe(100);
	});
});

/** A rep where every canonical test ran: the first takes `first` ms, the rest `rest` ms. */
const fullRep = (
	wallMs: number,
	first: number,
	rest = 2000,
	firstStatus: TestResult["status"] = "passed"
): RepResult => ({
	...rep(1, false, wallMs, first),
	tests: CANONICAL_IDS.map((id, i) => t(id, i === 0 ? first : rest, i === 0 ? firstStatus : "passed")),
});

describe("withRatios", () => {
	test("fastest gets 1, others their multiple", () => {
		const a = { name: "a", stats: frameworkStats({ reps: [fullRep(10_000, 1000)], prepareMs: 0, teardownMs: 0 }) };
		const b = { name: "b", stats: frameworkStats({ reps: [fullRep(20_000, 1500)], prepareMs: 0, teardownMs: 0 }) };
		const [ra, rb] = withRatios([a, b]);
		expect(ra?.stats.ratioToFastestSuite).toBe(1);
		expect(rb?.stats.ratioToFastestSuite).toBe(2);
		expect(rb?.stats.perTest["onboarding/steps-to-sign-in"].ratioToFastest).toBe(1.5);
		expect(ra?.stats.perTest["todos/add-complete-filter"].ratioToFastest).toBe(1);
	});

	test("a framework missing a test never sets the suite pace", () => {
		const partial = {
			name: "p",
			stats: frameworkStats({ reps: [rep(1, false, 5000, 500)], prepareMs: 0, teardownMs: 0 }),
		};
		const full = { name: "f", stats: frameworkStats({ reps: [fullRep(20_000, 1500)], prepareMs: 0, teardownMs: 0 }) };
		const [rp, rf] = withRatios([partial, full]);
		expect(rf?.stats.ratioToFastestSuite).toBe(1);
		expect(rp?.stats.ratioToFastestSuite).toBe(0.25);
	});

	test("a framework that failed a test never sets the pace", () => {
		const a = {
			name: "a",
			stats: frameworkStats({ reps: [fullRep(5000, 500, 2000, "failed")], prepareMs: 0, teardownMs: 0 }),
		};
		const b = { name: "b", stats: frameworkStats({ reps: [fullRep(20_000, 1500)], prepareMs: 0, teardownMs: 0 }) };
		const [ra, rb] = withRatios([a, b]);
		expect(rb?.stats.ratioToFastestSuite).toBe(1);
		expect(ra?.stats.ratioToFastestSuite).toBe(0.25);
		expect(rb?.stats.perTest["onboarding/steps-to-sign-in"].ratioToFastest).toBe(1);
		expect(ra?.stats.perTest["onboarding/steps-to-sign-in"].ratioToFastest).toBe(0.33);
	});
});

describe("stepVerb", () => {
	test("first token, lower-cased, quotes and punctuation stripped", () => {
		expect(stepVerb('fill getByTestId("x")')).toBe("fill");
		expect(stepVerb("Tap getByTestId(x) until check")).toBe("tap");
		expect(stepVerb('type "password1"')).toBe("type");
		expect(stepVerb('"wait" now')).toBe("wait");
		expect(stepVerb("dismiss.")).toBe("dismiss");
	});
	test("id=… collapses to id=", () => {
		expect(stepVerb("id=welcome-next")).toBe("id=");
		expect(stepVerb('id=welcome-title equals "Welcome"')).toBe("id=");
	});
	test("a call-shaped or path-shaped first token keeps its head", () => {
		expect(stepVerb('getByTestId("welcome-screen")')).toBe("getbytestid");
		expect(stepVerb("fragments/next-plan.yaml")).toBe("fragments");
	});
	test("an empty label is unlabelled", () => {
		expect(stepVerb("")).toBe("(unlabelled)");
		expect(stepVerb("  ")).toBe("(unlabelled)");
	});
});

describe("stepGroups", () => {
	const withSteps = (index: number, cold: boolean, steps: readonly [string, number][]): RepResult => ({
		...rep(index, cold, 10_000, 3000),
		tests: [
			{
				...t("onboarding/steps-to-sign-in", 3000),
				steps: steps.map(([label, ms]) => ({ kind: "x", label, ms, status: "passed" as const })),
			},
		],
	});

	test("groups warm steps by verb, sorted by total ms, shares sum to 1", () => {
		const reps = [
			withSteps(1, true, [["fill a", 99_999]]),
			withSteps(2, false, [
				["fill a", 3000],
				["tap b", 100],
				["tap c", 200],
				["expect d", 100],
			]),
			withSteps(3, false, [["fill a", 5000]]),
		];
		const groups = stepGroups(reps);
		expect(groups.map((g) => g.verb)).toEqual(["fill", "tap", "expect"]);
		expect(groups[0]).toEqual({
			kind: "verb",
			verb: "fill",
			n: 2,
			totalMs: 8000,
			share: 0.952,
			median: 4000,
			p95: 5000,
			max: 5000,
		});
		expect(groups[1]).toMatchObject({ verb: "tap", n: 2, totalMs: 300, median: 150, max: 200 });
		expect(groups.reduce((a, g) => a + g.share, 0)).toBeCloseTo(1, 1);
	});
	test("keeps the top 8 and folds the rest into other", () => {
		const labels = Array.from({ length: 10 }, (_, i) => [`v${i} x`, (i + 1) * 10] as [string, number]);
		const groups = stepGroups([withSteps(2, false, labels)]);
		expect(groups).toHaveLength(9);
		const other = groups[8];
		expect(other).toMatchObject({ kind: "other", verb: "other", n: 2, totalMs: 30, verbs: 2 });
		expect(groups.slice(0, 8).every((g) => g.kind === "verb")).toBe(true);
	});
	test("empty when no steps; falls back to all reps when only a cold one exists", () => {
		expect(stepGroups([rep(2, false, 1, 1)])).toEqual([]);
		expect(stepGroups([withSteps(1, true, [["tap a", 10]])])).toHaveLength(1);
	});
});
