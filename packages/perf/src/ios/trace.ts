import {
	buildReport,
	createAccumulator,
	hangFromRow,
	hangWindows,
	leakFromRow,
	type NativeReport,
	type RawHang,
	type RawLeak,
	sampleFromRow,
} from "./analyze";
import { HANG_SCHEMAS, LEAK_SCHEMAS, parseToc, pickSchema, SAMPLE_SCHEMAS, type TraceRun } from "./export";
import { exportTableArgv, exportTocArgv } from "./xctrace-argv";
import { createRowParser } from "./xml-rows";

export type TraceError = { code: "export_failed" | "no_samples" | "empty_trace"; message: string; hint?: string };

export type TraceResult<T> = { success: true; data: T } | { success: false; error: TraceError };

/** What reading a `.trace` reaches the machine through; the CLI injects exec and file streaming, tests inject fixtures. */
export type TraceDeps = {
	run: (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
	/** the file's text in chunks (an export can be hundreds of MB) */
	readChunks: (path: string) => AsyncIterable<string>;
	remove: (path: string) => void;
};

export type AnalyzeOptions = {
	/** scratch directory for the table exports */
	workDir: string;
	/** keep only this process's samples (`--all-processes` recordings) */
	pid?: number;
	traceStartWallMs?: number;
	/** the toc to use instead of exporting it */
	run?: number;
};

const fail = (code: TraceError["code"], message: string, hint?: string): TraceResult<never> => ({
	success: false,
	error: { code, message, ...(hint === undefined ? {} : { hint }) },
});

/** Export one table to `workDir` and stream it through `onRow`; the file is removed afterwards. */
async function streamTable(
	deps: TraceDeps,
	trace: string,
	schema: string,
	run: number,
	workDir: string,
	onRow: (cells: Parameters<Parameters<typeof createRowParser>[0]["onRow"]>[0], columns: string[]) => void
): Promise<TraceError | undefined> {
	const file = `${workDir}/${schema}.xml`;
	const res = await deps.run(exportTableArgv(trace, schema, file, run));
	if (res.exitCode !== 0) {
		return {
			code: "export_failed",
			message: `xctrace export ${schema} failed: ${(res.stderr || res.stdout).trim().slice(0, 300)}`,
		};
	}
	const parser = createRowParser({
		onSchema: () => undefined,
		onRow: (cells, _schema, columns) => onRow(cells, columns),
	});
	try {
		for await (const chunk of deps.readChunks(file)) parser.feed(chunk);
		parser.end();
	} finally {
		deps.remove(file);
	}
	return undefined;
}

/**
 * Read a recorded `.trace`: `--toc` to find the tables, then hangs, leaks and the CPU samples streamed one table at a
 * time. Hangs go first so the sample pass can collect each hang's main-thread stacks without keeping any sample.
 */
export async function analyzeTrace(
	deps: TraceDeps,
	trace: string,
	opts: AnalyzeOptions
): Promise<TraceResult<NativeReport>> {
	const toc = await deps.run(exportTocArgv(trace));
	if (toc.exitCode !== 0) {
		return fail(
			"export_failed",
			`xctrace export --toc failed: ${(toc.stderr || toc.stdout).trim().slice(0, 300)}`,
			"is the recording finished? xcrun xctrace export needs a complete .trace"
		);
	}
	const runs = parseToc(toc.stdout);
	const run: TraceRun | undefined = runs.find((r) => r.number === (opts.run ?? 1)) ?? runs[0];
	if (run === undefined) return fail("empty_trace", "the trace has no runs");
	const warnings: string[] = [];

	const hangs: RawHang[] = [];
	const hangSchema = pickSchema(run, HANG_SCHEMAS, "hang");
	if (hangSchema !== undefined) {
		const e = await streamTable(deps, trace, hangSchema, run.number, opts.workDir, (cells, columns) => {
			const h = hangFromRow(cells, columns);
			if (h !== undefined) hangs.push(h);
		});
		if (e !== undefined) warnings.push(e.message);
	}

	const leaks: RawLeak[] = [];
	const leakSchema = pickSchema(run, LEAK_SCHEMAS, "leak");
	if (leakSchema !== undefined) {
		const e = await streamTable(deps, trace, leakSchema, run.number, opts.workDir, (cells, columns) => {
			const l = leakFromRow(cells, columns);
			if (l !== undefined) leaks.push(l);
		});
		if (e !== undefined) warnings.push(e.message);
	}

	const sampleSchema = pickSchema(run, SAMPLE_SCHEMAS);
	if (sampleSchema === undefined) {
		return fail(
			"no_samples",
			`the trace has no CPU samples (tables: ${run.schemas.join(", ") || "none"})`,
			"record with the Time Profiler template"
		);
	}
	const acc = createAccumulator({ ...(opts.pid === undefined ? {} : { pid: opts.pid }), windows: hangWindows(hangs) });
	const e = await streamTable(deps, trace, sampleSchema, run.number, opts.workDir, (cells, columns) => {
		const s = sampleFromRow(cells, columns);
		if (s !== undefined) acc.add(s);
	});
	if (e !== undefined) return { success: false, error: e };
	const stats = acc.stats();
	if (stats.sampleCount === 0) {
		return fail(
			"no_samples",
			opts.pid === undefined ? "the trace holds no CPU samples" : `no CPU samples for pid ${opts.pid} in the trace`,
			"is the app running and busy while recording? attach to the right pid, or use --duration longer"
		);
	}
	return {
		success: true,
		data: buildReport({
			stats,
			hangs,
			leaks,
			...(opts.pid === undefined ? {} : { pid: opts.pid }),
			...(run.durationMs === undefined ? {} : { traceDurationMs: run.durationMs }),
			...(opts.traceStartWallMs === undefined ? {} : { traceStartWallMs: opts.traceStartWallMs }),
			warnings,
		}),
	};
}
