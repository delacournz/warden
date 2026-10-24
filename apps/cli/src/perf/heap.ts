import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command as Commander } from "@commander-js/extra-typings";
import {
	diffHeaps,
	formatBytes,
	HEAP_TOP,
	type HeapSummary,
	heapDiffSection,
	heapSection,
	MAX_PARSE_BYTES,
	type ParsedHeap,
	parseHeapSnapshot,
	summarizeHeap,
	takeHeapSnapshot,
} from "@delacour/warden-perf/js/heap";
import { readDevFlag } from "@delacour/warden-perf/js/js.types";
import { MAX_TEXT_LINES } from "@delacour/warden-perf/shared/caps";
import { DEV_BUILD_BANNER, renderMarkdown, SIMULATOR_BANNER } from "@delacour/warden-perf/shared/render-md";
import { ok } from "@delacour/warden-types/result";
import { reportError, type UiSuccess, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { emit } from "../output";
import type { PerfTarget } from "./device";
import { connectJs } from "./js";
import { defaultJsDeps, type JsDeps, jsUiError } from "./js-capture";
import { type JsOut, jsOutFor } from "./js-out";
import { withPerfOptions } from "./options";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";

export type PerfHeapSnapshotOptions = PerfOptionValues & { metro?: string };

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
		return { warning: `snapshot is ${formatBytes(bytes)}: not summarized; open it in Chrome DevTools` };
	}
	const parsed = parseHeapSnapshot(readFileSync(file, "utf8"));
	return parsed.success
		? { summary: summarizeHeap(parsed.data) }
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

function successOf(f: SnapshotFacts): UiSuccess {
	const next = [
		"warden perf mark <label>, act in the app, then warden perf heap snapshot again",
		`warden perf heap diff ${f.file} <later.heapsnapshot>`,
	];
	const text = renderMarkdown(
		{
			title: "Hermes heap snapshot",
			banners: [SIMULATOR_BANNER, ...(f.dev === true ? [DEV_BUILD_BANNER] : [])],
			summary: [
				`${f.app} on ${f.target.name ?? f.target.udid}: ${formatBytes(f.bytes)} snapshot in ${f.chunks} chunks`,
				`snapshot: ${f.file}`,
			],
			findings: [],
			sections: f.summary === undefined ? [] : [heapSection(f.summary)],
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

/**
 * `warden perf heap snapshot`: a Hermes heap snapshot of the running dev client, streamed to
 * `js/heap-<ts>.heapsnapshot` (opens in Chrome DevTools, Memory tab) with the top 15 constructors by self size and
 * count. Mutating: the snapshot freezes the JS thread while it is taken, so it needs the caller's lease on the
 * device. Retained sizes are not computed here; open the file for them.
 */
export function perfHeapSnapshot(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfHeapSnapshotOptions,
	js: JsDeps = defaultJsDeps
): Promise<number> {
	return runPerf(ctx, deps, "heap snapshot", "mutate", opts, async (target, env) => {
		const connected = await connectJs(ctx, deps, js, target, opts, env.timeoutMs);
		if (!connected.success) return connected;
		const { session, app } = connected.data;
		try {
			const out = jsOutFor(ctx, deps.session, target.udid, "heap");
			mkdirSync(out.dir, { recursive: true });
			const name = `heap-${stamp(ctx.now())}`;
			const file = join(out.dir, `${name}.heapsnapshot`);
			writeFileSync(file, "");
			const dev = await readDevFlag(session);
			const taken = await takeHeapSnapshot(session, (chunk) => appendFileSync(file, chunk));
			if (!taken.success) {
				rmSync(file, { force: true });
				return { success: false, error: jsUiError(taken.error) };
			}
			const { summary, warning } = summarizeFile(file, taken.data.bytes);
			const summaryPath = join(out.dir, `${name}.summary.json`);
			if (summary !== undefined) writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
			return ok(
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
	});
}

export type PerfHeapDiffOptions = { json?: boolean };

function load(
	ctx: CommandContext,
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
	const parsed = parseHeapSnapshot(text);
	return parsed.success ? parsed : { success: false, error: `${path}: ${parsed.error.message}` };
}

/** `warden perf heap diff <a> <b>`: constructor count and self-size deltas from snapshot `a` (before) to `b` (after). Reads files only. */
export function perfHeapDiff(ctx: CommandContext, a: string, b: string, opts: PerfHeapDiffOptions): number {
	const json = opts.json === true;
	const report = { command: "perf heap diff", label: "perf heap diff", json, startedAt: ctx.now() };
	const before = load(ctx, a);
	if (!before.success) return reportError(ctx, report, uiError("usage", before.error));
	const after = load(ctx, b);
	if (!after.success) return reportError(ctx, report, uiError("usage", after.error));
	const diff = diffHeaps(before.data, after.data, HEAP_TOP);
	const text = renderMarkdown({
		title: "Heap diff",
		banners: [],
		summary: [`${a} -> ${b}`],
		findings: [],
		sections: [heapDiffSection(diff)],
		next: [],
	});
	emit(ctx, json, { a, b, ...diff }, text, { scope: "perf heap diff" });
	return 0;
}

/** Wire `heap snapshot` and `heap diff` onto `warden perf`. */
export function registerHeap(cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps): void {
	const heap = cmd.command("heap").description("Hermes heap snapshots: take one, diff two");
	withPerfOptions(
		heap
			.command("snapshot")
			.description(
				"heap snapshot of the dev client (js/heap-<ts>.heapsnapshot) with the top constructors; needs your lease"
			)
			.option("--metro <url>", "Metro to attach through (default: the one serving the device)")
	).action(async (opts) => {
		done(await perfHeapSnapshot(ctx, deps, opts));
	});
	heap
		.command("diff")
		.description("constructor count and size deltas between two .heapsnapshot files")
		.argument("<before>", "earlier snapshot")
		.argument("<after>", "later snapshot")
		.option("--json", "machine-readable output")
		.action((before, after, opts) => {
			done(perfHeapDiff(ctx, before, after, opts));
		});
}
