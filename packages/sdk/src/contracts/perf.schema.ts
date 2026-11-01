import { z } from "zod";
import { platformSchema } from "./primitives.schema";

/**
 * `result` of every `warden perf … --json` command (inside the `warden ui` envelope, `uiJsonSchema`) and of the
 * matching `session.perf` / `warden.perf` SDK call. The engine's result types (`ops/perf/*`) are checked against
 * these in `perf.schema.test.ts`, so the CLI, the SDK and the documented contract cannot drift. Deep, tool-owned
 * detail (heap rows, trace hotspots, report sections) is kept loose: the keys named here are the stable ones.
 */

const SEVERITIES = ["critical", "warn", "info"] as const;

const findingBase = {
	severity: z.enum(SEVERITIES),
	/** time the problem costs the user, in ms (0 when it is not a duration) */
	costMs: z.number(),
	evidence: z.string(),
	fix: z.string(),
	/** follow-up `warden perf …` commands */
	next: z.array(z.string()),
};

class FindingSchemas {
	of<K extends string, S extends z.ZodRawShape>(kind: K, extra: S) {
		return z.object({ kind: z.literal(kind), ...findingBase, ...extra });
	}
}

const findingSchemas = new FindingSchemas();

const component = { component: z.string() };

/** One thing a report found, discriminated on `kind`. */
export const perfFindingSchema = z.discriminatedUnion("kind", [
	findingSchemas.of("slow-commit", { commitIndex: z.number() }),
	findingSchemas.of("slow-render", component),
	findingSchemas.of("memo-defeated", component),
	findingSchemas.of("context-cascade", component),
	findingSchemas.of("parent-cascade", component),
	findingSchemas.of("render-storm", { ...component, renders: z.number() }),
	findingSchemas.of("eager-mount", component),
	findingSchemas.of("effect-chain", component),
	findingSchemas.of("startup", { method: z.enum(["am-start", "xctrace", "approx"]), runs: z.number() }),
	findingSchemas.of("jank", { jankPct: z.number() }),
	findingSchemas.of("hang", { atMs: z.number() }),
	findingSchemas.of("cpu-hot", { thread: z.string(), cpuPct: z.number() }),
	findingSchemas.of("memory-growth", { slopeKbPerSec: z.number() }),
	findingSchemas.of("leak", { type: z.string(), count: z.number() }),
	findingSchemas.of("crash", { process: z.string() }),
	findingSchemas.of("anr", { process: z.string() }),
	findingSchemas.of("js-hotspot", { file: z.string(), line: z.number() }),
	findingSchemas.of("native-hotspot", { thread: z.string(), function: z.string(), selfPct: z.number() }),
]);
export type PerfFindingJson = z.infer<typeof perfFindingSchema>;

const statSchema = z.object({ min: z.number(), avg: z.number(), p95: z.number(), max: z.number() });

const deviceSchema = z.object({ udid: z.string(), platform: platformSchema, name: z.string().optional() });

const markSchema = z.object({ label: z.string(), wallMs: z.number(), atMs: z.number() });

const capturerSchema = z.object({ kind: z.string(), state: z.string(), out: z.string().optional() });

/** `perf start`'s `plan.json`. */
export const perfPlanSchema = z.object({
	version: z.literal(1),
	app: z.string(),
	cwd: z.string(),
	metrics: z.boolean(),
	frames: z.boolean(),
	logs: z.boolean(),
	js: z.boolean(),
	react: z.boolean(),
	native: z.object({ flavor: z.string() }).optional(),
	relaunch: z.boolean(),
	metroUrl: z.string().optional(),
	leaseId: z.string().optional(),
});

/** `result` of `warden perf start --json`. */
export const perfStartResultSchema = z.object({
	sessionId: z.string(),
	dir: z.string(),
	app: z.string(),
	maxDurationMs: z.number(),
	capturers: z.array(capturerSchema),
	plan: perfPlanSchema,
	launch: z.looseObject({ kind: z.enum(["launched", "failed"]) }).optional(),
	leaseId: z.string().optional(),
	next: z.array(z.string()),
});
export type PerfStartResultJson = z.infer<typeof perfStartResultSchema>;

/** `result` of `warden perf mark --json`. */
export const perfMarkResultSchema = z.object({ sessionId: z.string(), label: z.string(), atMs: z.number() });
export type PerfMarkResultJson = z.infer<typeof perfMarkResultSchema>;

const reportSectionSchema = z.looseObject({ id: z.string(), title: z.string(), lines: z.array(z.string()) });

const correlationSchema = z.looseObject({
	kind: z.enum(["hang-commit", "jank-commit"]),
	atMs: z.number(),
	durationMs: z.number(),
	text: z.string(),
});

/** `report.json`: the merged report of a session. */
export const perfReportSchema = z.object({
	version: z.literal(1),
	sessionId: z.string(),
	device: deviceSchema,
	app: z.string().optional(),
	startedAt: z.number(),
	durationMs: z.number(),
	stopReason: z.string().optional(),
	banners: z.array(z.string()),
	summary: z.array(z.string()),
	findings: z.array(perfFindingSchema),
	sections: z.array(reportSectionSchema),
	correlations: z.array(correlationSchema),
	marks: z.array(markSchema),
	metrics: z.looseObject({
		startupColdMs: z.number().optional(),
		startupWarmMs: z.number().optional(),
		jankPct: z.number().optional(),
		fps: z.number().optional(),
		cpuP95Pct: z.number().optional(),
		peakPssKb: z.number().optional(),
		peakRssKb: z.number().optional(),
		topCommitMs: z.number().optional(),
		hangCount: z.number().optional(),
		hangTotalMs: z.number().optional(),
		topFunctions: z.array(z.object({ name: z.string(), selfPct: z.number() })),
	}),
	next: z.array(z.string()),
});
export type PerfReportJsonDoc = z.infer<typeof perfReportSchema>;

/** `result` of `warden perf stop --json`. */
export const perfStopResultSchema = z.object({
	sessionId: z.string(),
	status: z.enum(["running", "stopped", "aborted"]),
	stopReason: z.string().nullable(),
	dir: z.string(),
	reportPath: z.string().optional(),
	report: perfReportSchema.nullable(),
});
export type PerfStopResultJson = z.infer<typeof perfStopResultSchema>;

/** `result` of `warden perf report --json`. */
export const perfReportResultSchema = z.object({
	sessionId: z.string(),
	dir: z.string(),
	report: perfReportSchema,
});

/** One row of `warden perf ls`. */
export const perfSessionRowSchema = z.object({
	id: z.string(),
	device: z.string(),
	platform: z.string(),
	app: z.string().nullable(),
	status: z.string(),
	startedAt: z.number(),
	maxDurationMs: z.number(),
	marks: z.number(),
});
export type PerfSessionRowJson = z.infer<typeof perfSessionRowSchema>;

/** `result` of `warden perf ls --json`. */
export const perfLsResultSchema = z.object({ sessions: z.array(perfSessionRowSchema) });

const startupStatsSchema = z.object({
	runs: z.number(),
	medianMs: z.number(),
	p90Ms: z.number(),
	minMs: z.number(),
	maxMs: z.number(),
});

/** `result` of `warden perf startup --json`. */
export const perfStartupResultSchema = z.object({
	version: z.literal(1),
	method: z.enum(["am-start", "xctrace", "simctl-approx"]),
	appId: z.string(),
	device: z.object({ udid: z.string(), platform: platformSchema, name: z.string().optional() }),
	startedAt: z.number(),
	runs: z.array(z.looseObject({ kind: z.enum(["cold", "warm"]) })),
	summary: z.object({ cold: startupStatsSchema.optional(), warm: startupStatsSchema.optional() }),
	marks: z.array(z.object({ name: z.string(), startTimeMs: z.number() })),
	notes: z.array(z.string()),
	findings: z.array(perfFindingSchema),
	path: z.string(),
});
export type PerfStartupResultJson = z.infer<typeof perfStartupResultSchema>;

/** `result` of `warden perf metrics --json` (the final summary; `--watch` also streams `{type:"sample"}` lines). */
export const perfMetricsResultSchema = z.object({
	app: z.string(),
	intervalMs: z.number(),
	summary: z.object({
		count: z.number(),
		durationMs: z.number(),
		cpuPct: statSchema.optional(),
		rssKb: statSchema,
		pssKb: statSchema.optional(),
		fps: statSchema.optional(),
		growth: z
			.object({
				metric: z.enum(["pss", "rss"]),
				startKb: z.number(),
				endKb: z.number(),
				slopeKbPerSec: z.number(),
				risingShare: z.number(),
			})
			.optional(),
	}),
	findings: z.array(perfFindingSchema),
	samples: z.string(),
	sessionId: z.string().optional(),
	interrupted: z.literal(true).optional(),
});
export type PerfMetricsResultJson = z.infer<typeof perfMetricsResultSchema>;

/** `result` of `warden perf memory --json`. */
export const perfMemoryResultSchema = z.object({
	app: z.string(),
	pid: z.number().optional(),
	meminfo: z
		.object({
			pid: z.number().optional(),
			totalPssKb: z.number(),
			totalRssKb: z.number().optional(),
			categories: z.array(z.object({ name: z.string(), pssKb: z.number() })),
		})
		.optional(),
	vmmap: z
		.object({
			footprintKb: z.number(),
			footprintPeakKb: z.number().optional(),
			regions: z.array(
				z.object({ type: z.string(), residentKb: z.number(), dirtyKb: z.number(), swappedKb: z.number() })
			),
		})
		.optional(),
	hprof: z.object({ path: z.string(), bytes: z.number() }).optional(),
	leaks: z
		.object({
			leakCount: z.number(),
			leakedBytes: z.number(),
			types: z.array(z.object({ type: z.string(), count: z.number() })),
		})
		.optional(),
	memgraph: z.string().optional(),
	findings: z.array(perfFindingSchema).optional(),
});
export type PerfMemoryResultJson = z.infer<typeof perfMemoryResultSchema>;

/** `result` of `warden perf frames --json`: Android reads, iOS reports `unsupported`. */
export const perfFramesResultSchema = z.discriminatedUnion("status", [
	z.looseObject({
		status: z.literal("ok"),
		app: z.string(),
		session: z.string().optional(),
		reset: z.boolean(),
		findings: z.array(perfFindingSchema),
		sampledFrames: z.number(),
		deadlineMs: z.number(),
		refreshHz: z.number(),
		fps: z.number(),
		jankPct: z.number(),
		sampleJankPct: z.number(),
		totalFrames: z.number(),
		jankyFrames: z.number(),
		droppedFrames: z.number(),
		frozenFrames: z.number(),
		worstFrameMs: z.number(),
		percentilesMs: z.object({
			p50: z.number().optional(),
			p90: z.number().optional(),
			p95: z.number().optional(),
			p99: z.number().optional(),
		}),
		worstWindows: z.array(z.looseObject({ mark: z.string().optional() })),
	}),
	z.object({
		status: z.literal("unsupported"),
		platform: z.literal("ios"),
		app: z.string(),
		reason: z.string(),
		hint: z.string(),
	}),
]);
export type PerfFramesResultJson = z.infer<typeof perfFramesResultSchema>;

/** `result` of `warden perf js --json`. */
export const perfJsResultSchema = z.object({
	sessionId: z.string().optional(),
	app: z.string(),
	dir: z.string(),
	files: z.object({ cpuprofile: z.string(), hotspots: z.string() }),
	hotspots: z.looseObject({
		version: z.literal(1),
		durationMs: z.number(),
		sampleCount: z.number(),
		activeMs: z.number(),
		topSelf: z.array(z.looseObject({})),
		topTotal: z.array(z.looseObject({})),
	}),
	findings: z.array(perfFindingSchema),
	next: z.array(z.string()),
});
export type PerfJsResultJson = z.infer<typeof perfJsResultSchema>;

const constructorStatSchema = z.looseObject({ name: z.string(), count: z.number(), selfSize: z.number() });

/** `result` of `warden perf heap snapshot --json`. */
export const perfHeapSnapshotResultSchema = z.object({
	sessionId: z.string().optional(),
	app: z.string(),
	file: z.string(),
	bytes: z.number(),
	dev: z.boolean().optional(),
	summaryFile: z.string().optional(),
	summary: z
		.object({
			nodeCount: z.number(),
			totalSelfSize: z.number(),
			topBySize: z.array(constructorStatSchema),
			topByCount: z.array(constructorStatSchema),
		})
		.optional(),
	next: z.array(z.string()),
});
export type PerfHeapSnapshotResultJson = z.infer<typeof perfHeapSnapshotResultSchema>;

/** `result` of `warden perf heap diff --json`. */
export const perfHeapDiffResultSchema = z.object({
	a: z.string(),
	b: z.string(),
	nodeCountDelta: z.number(),
	totalSizeDelta: z.number(),
	rows: z.array(
		z.object({
			name: z.string(),
			countA: z.number(),
			countB: z.number(),
			countDelta: z.number(),
			sizeA: z.number(),
			sizeB: z.number(),
			sizeDelta: z.number(),
		})
	),
});
export type PerfHeapDiffResultJson = z.infer<typeof perfHeapDiffResultSchema>;

/** One device log line, platform-neutral (also each NDJSON line of `perf logs --follow --json`). */
export const perfLogEntrySchema = z.object({
	ts: z.string(),
	tsMs: z.number(),
	pid: z.number(),
	tid: z.number(),
	level: z.enum(["V", "D", "I", "W", "E", "F"]),
	tag: z.string(),
	msg: z.string(),
});
export type PerfLogEntryJson = z.infer<typeof perfLogEntrySchema>;

/** `result` of `warden perf logs --json` (one-shot). */
export const perfLogsResultSchema = z.object({
	app: z.string(),
	count: z.number(),
	truncated: z.boolean(),
	entries: z.array(perfLogEntrySchema),
});
export type PerfLogsResultJson = z.infer<typeof perfLogsResultSchema>;

/** `result` of `warden perf crashes --json`. */
export const perfCrashesResultSchema = z.object({
	app: z.string(),
	count: z.number(),
	crashes: z.array(
		z.object({
			kind: z.enum(["crash", "anr"]),
			process: z.string(),
			summary: z.string(),
			at: z.string(),
			firstAppFrame: z.string().optional(),
			source: z.string(),
			pid: z.number().optional(),
			exceptionType: z.string().optional(),
			signal: z.string().optional(),
			subtype: z.string().optional(),
			crashedThread: z.string().optional(),
			frames: z.array(z.string()),
			file: z.string().optional(),
			symbolicated: z.array(z.string()).optional(),
		})
	),
	findings: z.array(perfFindingSchema),
	notes: z.array(z.string()),
});
export type PerfCrashesResultJson = z.infer<typeof perfCrashesResultSchema>;
