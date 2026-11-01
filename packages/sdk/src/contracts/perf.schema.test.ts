import { expect, test } from "bun:test";
import type { z } from "zod";
import type { CrashesResult } from "../ops/perf/crashes";
import type { FramesResult } from "../ops/perf/frames";
import type { HeapDiffResult, HeapSnapshotResult } from "../ops/perf/heap";
import type { JsResult } from "../ops/perf/js";
import type { LogsResult } from "../ops/perf/logs";
import type { SessionRow } from "../ops/perf/ls";
import type { MemoryResult } from "../ops/perf/memory";
import type { MetricsResult } from "../ops/perf/metrics";
import type { MarkResult, StartResult, StopResult } from "../ops/perf/session-ops";
import type { StartupResult } from "../ops/perf/startup";
import {
	type perfCrashesResultSchema,
	perfFindingSchema,
	type perfFramesResultSchema,
	type perfHeapDiffResultSchema,
	type perfHeapSnapshotResultSchema,
	type perfJsResultSchema,
	type perfLogsResultSchema,
	perfLsResultSchema,
	type perfMarkResultSchema,
	type perfMemoryResultSchema,
	type perfMetricsResultSchema,
	perfReportResultSchema,
	type perfSessionRowSchema,
	type perfStartResultSchema,
	type perfStartupResultSchema,
	type perfStopResultSchema,
} from "./perf.schema";

type Out<S extends z.ZodType> = z.output<S>;

type Assignable<From, To> = [From] extends [To] ? true : false;

/** Compile-time: the engine's result type is assignable to its contract (the CLI and the SDK emit these). */
export const conforms = {
	start: true satisfies Assignable<StartResult, Out<typeof perfStartResultSchema>>,
	stop: true satisfies Assignable<StopResult, Out<typeof perfStopResultSchema>>,
	mark: true satisfies Assignable<MarkResult, Out<typeof perfMarkResultSchema>>,
	row: true satisfies Assignable<SessionRow, Out<typeof perfSessionRowSchema>>,
	startup: true satisfies Assignable<StartupResult, Out<typeof perfStartupResultSchema>>,
	metrics: true satisfies Assignable<MetricsResult, Out<typeof perfMetricsResultSchema>>,
	memory: true satisfies Assignable<MemoryResult, Out<typeof perfMemoryResultSchema>>,
	frames: true satisfies Assignable<FramesResult, Out<typeof perfFramesResultSchema>>,
	js: true satisfies Assignable<JsResult, Out<typeof perfJsResultSchema>>,
	heapSnapshot: true satisfies Assignable<HeapSnapshotResult, Out<typeof perfHeapSnapshotResultSchema>>,
	heapDiff: true satisfies Assignable<HeapDiffResult, Out<typeof perfHeapDiffResultSchema>>,
	logs: true satisfies Assignable<LogsResult, Out<typeof perfLogsResultSchema>>,
	crashes: true satisfies Assignable<CrashesResult, Out<typeof perfCrashesResultSchema>>,
};

test("perfFindingSchema discriminates on kind and rejects a missing extra", () => {
	const base = { severity: "warn", costMs: 12, evidence: "e", fix: "f", next: [] };
	expect(perfFindingSchema.parse({ kind: "jank", jankPct: 4, ...base }).kind).toBe("jank");
	expect(() => perfFindingSchema.parse({ kind: "jank", ...base })).toThrow();
	expect(() => perfFindingSchema.parse({ kind: "nope", ...base })).toThrow();
});

test("perfLsResultSchema and perfReportResultSchema reject malformed documents", () => {
	expect(perfLsResultSchema.parse({ sessions: [] }).sessions).toEqual([]);
	expect(() => perfLsResultSchema.parse({ sessions: [{ id: "x" }] })).toThrow();
	expect(() => perfReportResultSchema.parse({ sessionId: "x", dir: "d" })).toThrow();
});
