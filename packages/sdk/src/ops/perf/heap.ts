import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	HEAP_TOP,
	type HeapDiff,
	type HeapSummary,
	heapAnalyzer,
	MAX_PARSE_BYTES,
	type ParsedHeap,
} from "@delacour/warden-perf/js/heap";
import { jsCdpReader } from "@delacour/warden-perf/js/js.types";
import { MAX_TEXT_LINES } from "@delacour/warden-perf/shared/caps";
import { DEV_BUILD_BANNER, markdownRenderer, SIMULATOR_BANNER } from "@delacour/warden-perf/shared/render-md";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { opError } from "../errors";
import type { PerfEnv } from "./env";
import { connectJsApp } from "./js";
import { type JsDeps, jsUiError } from "./js-capture";
import { type JsOut, jsOutFor } from "./js-out";
import type { PerfDone, PerfEngineDeps, PerfOutcome, PerfTarget } from "./types";

/** `20261024T101500Z`: sorts by time and has no characters a shell or Windows path dislikes. */
const stamp = (ms: number): string =>
	new Date(ms)
		.toISOString()
		.replace(/\.\d+Z$/, "Z")
		.replace(/[-:]/g, "");

type Summarized = { summary?: HeapSummary; warning?: string };

/** The top-constructor summary of a snapshot on disk, or why there is none (the file is kept either way). */
function summarizeFile(file: string, bytes: number): Summarized {
	if (statSync(file).size > MAX_PARSE_BYTES) {
		return { warning: `snapshot is ${heapAnalyzer.formatBytes(bytes)}: not summarized; open it in Chrome DevTools` };
	}
	const parsed = heapAnalyzer.parseHeapSnapshot(readFileSync(file, "utf8"));
	return parsed.success
		? { summary: heapAnalyzer.summarizeHeap(parsed.data) }
		: { warning: `snapshot written but not summarized: ${parsed.error.message}` };
}

type SnapshotFacts = {
	target: PerfTarget;
	app: string;
	out: JsOut;
	file: string;
	summaryPath: string;
	summary: HeapSummary | undefined;
	warning: string | undefined;
	dev: boolean | undefined;
	bytes: number;
	chunks: number;
};

function successOf(f: SnapshotFacts): PerfDone<HeapSnapshotResult> {
	const next = [
		"warden perf mark <label>, act in the app, then warden perf heap snapshot again",
		`warden perf heap diff ${f.file} <later.heapsnapshot>`,
	];
	const text = markdownRenderer.renderMarkdown(
		{
			title: "Hermes heap snapshot",
			banners: [SIMULATOR_BANNER, ...(f.dev === true ? [DEV_BUILD_BANNER] : [])],
			summary: [
				`${f.app} on ${f.target.name ?? f.target.udid}: ${heapAnalyzer.formatBytes(f.bytes)} snapshot in ${f.chunks} chunks`,
				`snapshot: ${f.file}`,
			],
			findings: [],
			sections: f.summary === undefined ? [] : [heapAnalyzer.heapSection(f.summary)],
			next,
		},
		{ maxLines: MAX_TEXT_LINES }
	);
	return {
		device: { udid: f.target.udid, platform: f.target.platform, name: f.target.name },
		result: {
			...(f.out.sessionId === undefined ? {} : { sessionId: f.out.sessionId }),
			app: f.app,
			file: f.file,
			bytes: f.bytes,
			...(f.dev === undefined ? {} : { dev: f.dev }),
			...(f.summary === undefined ? {} : { summaryFile: f.summaryPath, summary: f.summary }),
			next,
		},
		text,
		warnings: f.warning === undefined ? [] : [f.warning],
	};
}

function loadHeap(
	ctx: Pick<PerfEnv, "cwd">,
	path: string
): { success: true; data: ParsedHeap } | { success: false; error: string } {
	const full = resolve(ctx.cwd, path);
	let text: string;
	try {
		if (statSync(full).size > MAX_PARSE_BYTES) return { success: false, error: `${path} is too big to diff here` };
		text = readFileSync(full, "utf8");
	} catch (error) {
		return { success: false, error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
	const parsed = heapAnalyzer.parseHeapSnapshot(text);
	return parsed.success ? parsed : { success: false, error: `${path}: ${parsed.error.message}` };
}

/** The `result` of `perf heap snapshot --json`. */
export type HeapSnapshotResult = {
	sessionId?: string;
	app: string;
	file: string;
	bytes: number;
	dev?: boolean;
	summaryFile?: string;
	summary?: HeapSummary;
	next: string[];
};

/**
 * A Hermes heap snapshot of the running dev client on a resolved device and app, streamed to
 * `js/heap-<ts>.heapsnapshot` with the top constructors. Mutating: the snapshot freezes the JS thread while it is
 * taken, so the caller holds the device lease.
 */
export async function heapSnapshotWork(
	ctx: PerfEnv,
	deps: PerfEngineDeps,
	js: JsDeps,
	target: PerfTarget,
	appId: string,
	metro: string | undefined,
	timeoutMs: number
): PerfOutcome<HeapSnapshotResult> {
	const connected = await connectJsApp(ctx, deps, js, target, appId, metro, timeoutMs);
	if (!connected.success) return connected;
	const { session, app } = connected.data;
	try {
		const out = jsOutFor(ctx, deps.session, target.udid, "heap");
		mkdirSync(out.dir, { recursive: true });
		const name = `heap-${stamp(ctx.now())}`;
		const file = join(out.dir, `${name}.heapsnapshot`);
		writeFileSync(file, "");
		const dev = await jsCdpReader.readDevFlag(session);
		const taken = await heapAnalyzer.takeHeapSnapshot(session, (chunk) => appendFileSync(file, chunk));
		if (!taken.success) {
			rmSync(file, { force: true });
			return { success: false, error: jsUiError(taken.error) };
		}
		const { summary, warning } = summarizeFile(file, taken.data.bytes);
		const summaryPath = join(out.dir, `${name}.summary.json`);
		if (summary !== undefined) writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
		return resultFactory.ok(
			successOf({
				target,
				app,
				out,
				file,
				summaryPath,
				summary,
				warning,
				dev,
				bytes: taken.data.bytes,
				chunks: taken.data.chunks,
			})
		);
	} finally {
		session.close();
	}
}

/** The `result` of `perf heap diff --json`. */
export type HeapDiffResult = { a: string; b: string } & HeapDiff;

/** Constructor count and self-size deltas from snapshot `a` (before) to `b` (after), read from files. */
export function heapDiffWork(
	ctx: Pick<PerfEnv, "cwd">,
	a: string,
	b: string
): Result<{ result: HeapDiffResult; text: string }, WardenError> {
	const before = loadHeap(ctx, a);
	if (!before.success) return { success: false, error: opError("usage", before.error) };
	const after = loadHeap(ctx, b);
	if (!after.success) return { success: false, error: opError("usage", after.error) };
	const diff = heapAnalyzer.diffHeaps(before.data, after.data, HEAP_TOP);
	const text = markdownRenderer.renderMarkdown({
		title: "Heap diff",
		banners: [],
		summary: [`${a} -> ${b}`],
		findings: [],
		sections: [heapAnalyzer.heapDiffSection(diff)],
		next: [],
	});
	return resultFactory.ok({ result: { a, b, ...diff }, text });
}
