import { z } from "zod";

/** `bench-results.json`, versioned. Every duration is milliseconds; `*At` are ISO-8601 strings. */
export const SCHEMA_VERSION = 1;

export const platformSchema = z.enum(["ios", "android"]);
export type Platform = z.infer<typeof platformSchema>;

/** The 8 parity tests every framework runs (the example app's flows minus `devtools`). */
export const CANONICAL_IDS = [
	"onboarding/steps-to-sign-in",
	"sign-in/field-errors",
	"sign-in/locked-account",
	"sign-in/valid-credentials",
	"todos/add-complete-filter",
	"todo-detail/open-toggle-delete",
	"todo-detail/deep-link",
	"settings/account-switches-sign-out",
] as const;
export const canonicalIdSchema = z.enum(CANONICAL_IDS);
export type CanonicalId = z.infer<typeof canonicalIdSchema>;

export const frameworkIdSchema = z.enum(["warden", "maestro", "argent", "agent-device", "tester-army", "detox"]);

export const testStatusSchema = z.enum(["passed", "failed", "skipped", "timed-out", "missing"]);
export type TestStatus = z.infer<typeof testStatusSchema>;

export const stepResultSchema = z.object({
	/** the step family: `tap`, `fill`, `assert`, `launch`, … (framework-native kinds kept as-is) */
	kind: z.string(),
	label: z.string(),
	ms: z.number(),
	status: z.enum(["passed", "failed", "skipped"]),
});
export type StepResult = z.infer<typeof stepResultSchema>;

export const artifactSchema = z.object({
	kind: z.enum(["screenshot", "video", "log", "junit", "json"]),
	/** relative to the run's out dir */
	path: z.string(),
});

export const testResultSchema = z.object({
	id: canonicalIdSchema,
	/** the framework's own name for the test (file / flow / title) */
	nativeName: z.string(),
	status: testStatusSchema,
	/** the framework's own measurement, as reported (undefined when `missing`) */
	durationMs: z.number().optional(),
	steps: z.array(stepResultSchema).optional(),
	error: z.string().optional(),
	artifacts: z.array(artifactSchema).optional(),
});
export type TestResult = z.infer<typeof testResultSchema>;

export const repResultSchema = z.object({
	/** 1-based */
	index: z.number().int().positive(),
	cold: z.boolean(),
	/** harness-measured wall time of the whole suite process (`Bun.nanoseconds()`) */
	wallMs: z.number(),
	wallSource: z.literal("harness"),
	startedAt: z.string(),
	tests: z.array(testResultSchema),
	/** `artifacts/<framework>/rep-<n>`, relative to the run's out dir */
	rawArtifactDir: z.string(),
});
export type RepResult = z.infer<typeof repResultSchema>;

export const distSchema = z.object({
	n: z.number().int().nonnegative(),
	median: z.number(),
	p95: z.number(),
	min: z.number(),
	max: z.number(),
	stddev: z.number(),
	cvPct: z.number(),
});
export type Dist = z.infer<typeof distSchema>;

export const seriesSchema = z.object({
	cpuAvgPct: z.number(),
	cpuPeakPct: z.number(),
	rssAvgBytes: z.number(),
	rssPeakBytes: z.number(),
	samples: z.number().int().nonnegative(),
});
export type Series = z.infer<typeof seriesSchema>;

export const perTestStatsSchema = distSchema.extend({
	/** this framework's median over the fastest framework's median for the same test (1 = fastest) */
	ratioToFastest: z.number().optional(),
	passRate: z.number(),
	/** fraction of reps whose status differs from the majority */
	flakeRate: z.number(),
});
export type PerTestStats = z.infer<typeof perTestStatsSchema>;

export const frameworkStatsSchema = z.object({
	warmSuiteWall: distSchema,
	coldSuiteWallMs: z.number().optional(),
	perTest: z.record(canonicalIdSchema, perTestStatsSchema),
	/** median over warm reps of (suite wall − Σ test durations) */
	overheadMs: z.number(),
	/** rep-1 wall − median(warm wall) + prepareMs */
	coldStartMs: z.number().optional(),
	/** rep-1 first test − median(warm first test) */
	firstTestOverheadMs: z.number().optional(),
	prepareMs: z.number(),
	teardownMs: z.number(),
	stepLatency: distSchema.optional(),
	passRate: z.number(),
	flakeRate: z.number(),
	ratioToFastestSuite: z.number().optional(),
});
export type FrameworkStats = z.infer<typeof frameworkStatsSchema>;

export const residueSchema = z.object({
	processes: z.array(z.string()),
	driverApps: z.array(z.string()),
	paths: z.array(z.object({ path: z.string(), deltaBytes: z.number() })),
});
export type Residue = z.infer<typeof residueSchema>;

export const footprintSchema = z.object({
	testSourceLoc: z.number().int().nonnegative(),
	testSourceBytes: z.number().int().nonnegative(),
	/** package-local deps (node_modules) the framework needs; 0 for global tools */
	depsBytes: z.number().int().nonnegative(),
	/** the framework's own binaries / runner apps on disk, when known */
	binaryBytes: z.number().int().nonnegative(),
	notes: z.array(z.string()),
});
export type Footprint = z.infer<typeof footprintSchema>;

export const phaseSchema = z.enum(["doctor", "prepare", "run", "teardown"]);
export type Phase = z.infer<typeof phaseSchema>;

export const frameworkResultSchema = z.discriminatedUnion("status", [
	z.object({
		framework: frameworkIdSchema,
		status: z.literal("unsupported"),
		version: z.string().optional(),
		reason: z.string(),
	}),
	z.object({
		framework: frameworkIdSchema,
		status: z.literal("failed"),
		version: z.string(),
		phase: phaseSchema,
		error: z.string(),
		partial: z.array(repResultSchema).optional(),
	}),
	z.object({
		framework: frameworkIdSchema,
		status: z.literal("ok"),
		version: z.string(),
		phases: z.object({ prepareMs: z.number(), teardownMs: z.number() }),
		reps: z.array(repResultSchema),
		resources: z.object({ host: seriesSchema, sim: seriesSchema }),
		residue: residueSchema,
		footprint: footprintSchema,
		stats: frameworkStatsSchema,
	}),
]);
export type FrameworkResult = z.infer<typeof frameworkResultSchema>;
export type OkFrameworkResult = Extract<FrameworkResult, { status: "ok" }>;

export const hostSchema = z.object({
	model: z.string(),
	cpu: z.string(),
	cores: z.number().int(),
	memBytes: z.number(),
	macos: z.string(),
	xcode: z.string().optional(),
	java: z.string().optional(),
	node: z.string().optional(),
	bun: z.string(),
	warden: z.string(),
	loadAvgAtStart: z.number(),
});
export type Host = z.infer<typeof hostSchema>;

export const benchRunSchema = z.object({
	schemaVersion: z.literal(SCHEMA_VERSION),
	id: z.string(),
	startedAt: z.string(),
	endedAt: z.string().optional(),
	host: hostSchema,
	device: z.object({
		platform: platformSchema,
		udid: z.string(),
		name: z.string().optional(),
		runtime: z.string().optional(),
		leaseId: z.string().optional(),
	}),
	app: z.object({
		bundleId: z.string(),
		appPath: z.string(),
		/** warden's build hash (the fingerprint key) */
		hash: z.string(),
		sha256: z.string(),
		bytes: z.number(),
	}),
	options: z.object({
		runs: z.number().int().positive(),
		retries: z.number().int().nonnegative(),
		rebootBetween: z.boolean(),
		frameworks: z.array(frameworkIdSchema),
		caffeinated: z.boolean(),
	}),
	frameworks: z.array(frameworkResultSchema),
});
export type BenchRun = z.infer<typeof benchRunSchema>;

/** Parse `bench-results.json` text; the issues as one string on failure. */
export function parseBenchRun(text: string): { success: true; data: BenchRun } | { success: false; error: string } {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (e) {
		return { success: false, error: `not JSON: ${e instanceof Error ? e.message : String(e)}` };
	}
	const parsed = benchRunSchema.safeParse(json);
	if (parsed.success) return { success: true, data: parsed.data };
	return { success: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}
