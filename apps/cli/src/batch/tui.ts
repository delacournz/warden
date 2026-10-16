import type { BatchEvent } from "@delacour/warden-core/batch/schedule";
import { formatDuration } from "@delacour/warden-core/duration";
import { SYMBOLS } from "../ui";
import type { FlowMark } from "./flow-progress";
import type { RunnerReport } from "./runner-report";

/** One cell of a segmented bar. */
export type Cell = FlowMark | "running" | "pending";

/** Live state of one device in the batch grid (a `single` pool's devices share their worker). */
export type DeviceView = {
	worker: number;
	udid: string;
	name: string;
	current?: { job: string; startedAt: number; attempt: number };
	passed: number;
	failed: number;
	idle: boolean;
	/** finished jobs, in order (a retried attempt only counts once it is final) */
	results: FlowMark[];
	/** `mode: "single"`: the flows this device ran, from the runner's report */
	ran?: Array<{ id: string; mark: FlowMark }>;
};

/** `mode: "single"`: the one runner of `worker`, running every flow, marked as its output reports them. */
export type RunnerView = { worker: number; flows: Array<{ id: string; mark?: FlowMark }> };

export type BatchView = {
	startedAt: number;
	now: number;
	total: number;
	devices: DeviceView[];
	/** job → its 1-based place in the order jobs started (retries keep their job's place) */
	ordinals: Record<string, number>;
	/** job → where it stands (a job awaiting its retry stays running) */
	jobs: Record<string, FlowMark | "running">;
	runners?: RunnerView[];
	/** set by the `done` event */
	result?: { ok: boolean; stopped: boolean };
};

export type RenderOptions = { width: number; color: boolean };

export function initialView(
	devices: ReadonlyArray<{ worker: number; udid: string; name: string }>,
	total: number,
	startedAt: number
): BatchView {
	return {
		startedAt,
		now: startedAt,
		total,
		ordinals: {},
		jobs: {},
		devices: devices.map((d) => ({ ...d, passed: 0, failed: 0, idle: false, results: [] })),
	};
}

/** One runner per worker tracking `flowIds` (a `single` run: each worker's runner runs them all). */
export function withRunners(view: BatchView, flowIds: readonly string[]): BatchView {
	const workers = [...new Set(view.devices.map((d) => d.worker))];
	return { ...view, runners: workers.map((worker) => ({ worker, flows: flowIds.map((id) => ({ id })) })) };
}

const marked = (flows: RunnerView["flows"], marks: Readonly<Record<string, FlowMark>>): RunnerView["flows"] =>
	flows.map((f) => {
		const mark = marks[f.id] ?? f.mark;
		return mark ? { id: f.id, mark } : { id: f.id };
	});

/** `worker`'s runner takes on `ids` (the shard its job runs): flows it already tracks keep their marks. */
export function addRunnerFlows(view: BatchView, worker: number, ids: readonly string[]): BatchView {
	if (!view.runners) return view;
	return {
		...view,
		runners: view.runners.map((r) => {
			if (r.worker !== worker) return r;
			const fresh = ids.filter((id) => !r.flows.some((f) => f.id === id)).map((id) => ({ id }));
			return { ...r, flows: [...r.flows, ...fresh] };
		}),
	};
}

/** Marks read off `worker`'s runner output (a new view; flows it doesn't track are ignored). */
export function applyFlowMarks(view: BatchView, worker: number, marks: Readonly<Record<string, FlowMark>>): BatchView {
	if (!view.runners) return view;
	return {
		...view,
		runners: view.runners.map((r) => (r.worker === worker ? { ...r, flows: marked(r.flows, marks) } : r)),
	};
}

/** The runner's report: each device gets the flows it ran, and its verdicts settle every runner's flows. */
export function applyRunnerReport(view: BatchView, report: RunnerReport): BatchView {
	if (!view.runners) return view;
	return {
		...view,
		runners: view.runners.map((r) => ({ ...r, flows: marked(r.flows, report.flows) })),
		devices: view.devices.map((d) => ({ ...d, ran: report.devices[d.udid] ?? [] })),
	};
}

/** Fold one scheduler event into the view (returns a new view). */
export function applyEvent(view: BatchView, event: BatchEvent): BatchView {
	const now = Math.max(view.now, event.type === "job-end" ? event.endedAt : event.at);
	const update = (worker: number, fn: (d: DeviceView) => DeviceView) => ({
		...view,
		now,
		devices: view.devices.map((d) => (d.worker === worker ? fn(d) : d)),
	});
	switch (event.type) {
		case "job-start": {
			const started = update(event.worker, (d) => ({
				...d,
				idle: false,
				current: { job: event.job, startedAt: event.at, attempt: event.attempt },
			}));
			const next = { ...started, jobs: { ...view.jobs, [event.job]: "running" as const } };
			if (event.job in view.ordinals) return next;
			return { ...next, ordinals: { ...view.ordinals, [event.job]: Object.keys(view.ordinals).length + 1 } };
		}
		case "job-end": {
			const mark: FlowMark | undefined = event.exitCode === 0 ? "passed" : event.willRetry ? undefined : "failed";
			const next = update(event.worker, ({ current: _, ...d }) => ({
				...d,
				passed: d.passed + (mark === "passed" ? 1 : 0),
				failed: d.failed + (mark === "failed" ? 1 : 0),
				results: mark ? [...d.results, mark] : d.results,
			}));
			return mark ? { ...next, jobs: { ...view.jobs, [event.job]: mark } } : next;
		}
		case "worker-idle":
			return update(event.worker, ({ current: _, ...d }) => ({ ...d, idle: true }));
		case "done":
			return { ...view, now, result: { ok: event.ok, stopped: event.stopped } };
	}
}

/** The first row of each worker (a `single` pool's rows share one worker and its job counts). */
function workerHeads(view: BatchView): DeviceView[] {
	return view.devices.filter((d, i) => view.devices.findIndex((o) => o.worker === d.worker) === i);
}

function totals(view: BatchView): { passed: number; failed: number } {
	return workerHeads(view).reduce((t, d) => ({ passed: t.passed + d.passed, failed: t.failed + d.failed }), {
		passed: 0,
		failed: 0,
	});
}

type Style = "dim" | "bold" | "green" | "red" | "cyan" | "yellow";
type Segment = { text: string; style?: Style };

const SGR: Record<Style, [string, string]> = {
	dim: ["\u001b[2m", "\u001b[22m"],
	bold: ["\u001b[1m", "\u001b[22m"],
	green: ["\u001b[32m", "\u001b[39m"],
	red: ["\u001b[31m", "\u001b[39m"],
	cyan: ["\u001b[36m", "\u001b[39m"],
	yellow: ["\u001b[33m", "\u001b[39m"],
};

/** Join segments, cut to `max` visible columns, colour when asked. */
function line(segments: Segment[], max: number, color: boolean): string {
	let left = max;
	let out = "";
	for (const s of segments) {
		if (left <= 0) break;
		const text = [...s.text].slice(0, left).join("");
		left -= [...text].length;
		const sgr = s.style ? SGR[s.style] : undefined;
		out += color && sgr ? `${sgr[0]}${text}${sgr[1]}` : text;
	}
	return color ? out : out.trimEnd();
}

function pad(text: string, width: number): string {
	const chars = [...text];
	if (chars.length > width) return `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
	return text + " ".repeat(width - chars.length);
}

const CELL: Record<Cell, Segment> = {
	passed: { text: "█", style: "green" },
	failed: { text: "×", style: "red" },
	running: { text: "▸", style: "cyan" },
	pending: { text: "░", style: "dim" },
};

/** What a bucket of cells shows: a failure first, then work still running, still pending, else passed. */
const RANK: Cell[] = ["failed", "running", "pending", "passed"];

/** A segmented bar: one column per cell, or at most `width` columns each standing for a bucket of cells. */
function segmentBar(cells: readonly Cell[], width: number): Segment[] {
	const columns =
		cells.length <= width
			? cells
			: Array.from({ length: width }, (_, i) => {
					const bucket = cells.slice(
						Math.floor((i * cells.length) / width),
						Math.floor(((i + 1) * cells.length) / width)
					);
					return RANK.find((c) => bucket.includes(c)) ?? "pending";
				});
	const out: Segment[] = [];
	for (const cell of columns) {
		const last = out.at(-1);
		const { text, style } = CELL[cell];
		if (last && last.style === style) last.text += text;
		else out.push({ text, style });
	}
	return out;
}

const BAR_WIDTH = 30;
const DEVICE_BAR_WIDTH = 12;
const NAME_WIDTH = 20;

/** Flow counts across the runners; undefined when there are none (count jobs instead). */
function flowTotals(view: BatchView): { passed: number; failed: number; total: number } | undefined {
	if (!view.runners) return undefined;
	const flows = view.runners.flatMap((r) => r.flows);
	const count = (mark: FlowMark) => flows.filter((f) => f.mark === mark).length;
	return { passed: count("passed"), failed: count("failed"), total: flows.length };
}

/** The header's cells: every runner's flows (as many running as the runner has busy devices), else every job in start order. */
function overallCells(view: BatchView): Cell[] {
	if (view.runners)
		return view.runners.flatMap((r) => {
			let busy = view.devices.filter((d) => d.worker === r.worker && d.current).length;
			return r.flows.map((f): Cell => f.mark ?? (busy-- > 0 ? "running" : "pending"));
		});
	const started = Object.entries(view.ordinals)
		.sort(([, a], [, b]) => a - b)
		.map(([job]): Cell => view.jobs[job] ?? "pending");
	return [...started, ...Array.from({ length: Math.max(0, view.total - started.length) }, (): Cell => "pending")];
}

function header(view: BatchView, max: number, color: boolean): string {
	const tally = flowTotals(view) ?? { ...totals(view), total: view.total };
	const { passed, failed, total } = tally;
	const done = passed + failed;
	const state: Segment = view.result
		? view.result.ok
			? { text: `  ${SYMBOLS.ok} done`, style: "green" }
			: { text: view.result.stopped ? `  ${SYMBOLS.fail} stopped` : `  ${SYMBOLS.fail} failed`, style: "red" }
		: { text: "" };
	return line(
		[
			{ text: "warden batch  ", style: "bold" },
			...segmentBar(overallCells(view), BAR_WIDTH),
			{ text: `  ${done}/${total}  ` },
			{ text: `${SYMBOLS.ok}${passed}`, style: "green" },
			{ text: " " },
			{ text: `${SYMBOLS.fail}${failed}`, style: failed > 0 ? "red" : "dim" },
			{ text: `  ${formatDuration(view.now - view.startedAt)}`, style: "dim" },
			state,
		],
		max,
		color
	);
}

type Columns = { id: number; name: number; job: number };

function deviceStatus(d: DeviceView, width: number): Segment {
	if (!d.current) return { text: pad(`${SYMBOLS.idle} ${d.idle ? "idle" : "waiting"}`, width), style: "dim" };
	const retry = d.current.attempt > 0 ? ` (retry ${d.current.attempt})` : "";
	return { text: pad(`${SYMBOLS.run} ${d.current.job}${retry}`, width), style: retry ? "yellow" : "cyan" };
}

/** A row's cells: the flows the report says it ran; a runner's device until then, one running cell while busy; else its jobs + the current one. */
function deviceCells(view: BatchView, d: DeviceView): Cell[] {
	if (d.ran) return d.ran.map((f) => f.mark);
	const current: Cell[] = d.current ? ["running"] : [];
	if (view.runners?.some((r) => r.worker === d.worker)) return current;
	return [...d.results, ...current];
}

function deviceRow(view: BatchView, d: DeviceView, cols: Columns, max: number, color: boolean): string {
	const elapsed = d.current ? formatDuration(view.now - d.current.startedAt) : "";
	const passed = d.ran ? d.ran.filter((f) => f.mark === "passed").length : d.passed;
	const failed = d.ran ? d.ran.filter((f) => f.mark === "failed").length : d.failed;
	return line(
		[
			{ text: `${String(d.worker).padStart(cols.id)} `, style: "dim" },
			{ text: pad(d.name, cols.name) },
			{ text: "  " },
			deviceStatus(d, cols.job),
			{ text: `  ${elapsed.padStart(6)}  `, style: "dim" },
			{ text: `${SYMBOLS.ok}${String(passed).padEnd(3)}`, style: "green" },
			{ text: " " },
			{ text: `${SYMBOLS.fail}${String(failed).padEnd(3)}`, style: failed > 0 ? "red" : "dim" },
			{ text: " " },
			...segmentBar(deviceCells(view, d), DEVICE_BAR_WIDTH),
		],
		max,
		color
	);
}

const FLOW_INDENT = "    ";

function flowSegment(flow: { id: string; mark?: FlowMark }): Segment {
	if (flow.mark === "passed") return { text: `✓ ${flow.id}`, style: "green" };
	if (flow.mark === "failed") return { text: `✗ ${flow.id}`, style: "red" };
	return { text: `· ${flow.id}`, style: "dim" };
}

/** A row's flows, two spaces apart, wrapped to `max` columns under the row. */
function flowLines(flows: ReadonlyArray<{ id: string; mark?: FlowMark }>, max: number, color: boolean): string[] {
	const lines: Segment[][] = [];
	let current: Segment[] = [];
	let width = FLOW_INDENT.length;
	for (const flow of flows) {
		const segment = flowSegment(flow);
		const size = [...segment.text].length + 2;
		if (current.length > 0 && width + size > max) {
			lines.push(current);
			current = [];
			width = FLOW_INDENT.length;
		}
		current.push({ text: current.length > 0 ? "  " : FLOW_INDENT }, segment);
		width += size;
	}
	if (current.length > 0) lines.push(current);
	return lines.map((segments) => line(segments, max, color));
}

/** The grid: a header (overall segmented bar, ✓/✗, elapsed) + one row per device (+ its runner's flows, under the runner's last row). Pure — no ANSI cursor moves. */
export function render(view: BatchView, opts: RenderOptions): string {
	const max = Math.max(10, opts.width - 1);
	const id = String(Math.max(0, ...view.devices.map((d) => d.worker))).length;
	const name = Math.min(NAME_WIDTH, Math.max(4, ...view.devices.map((d) => [...d.name].length)));
	const job = Math.max(8, max - (id + 1 + name + 2 + 2 + 7 + 2 + 9 + DEVICE_BAR_WIDTH));
	const last = (i: number, worker: number) => !view.devices.slice(i + 1).some((o) => o.worker === worker);
	const rows = view.devices.flatMap((d, i) => [
		deviceRow(view, d, { id, name, job }, max, opts.color),
		...(last(i, d.worker)
			? flowLines(view.runners?.find((r) => r.worker === d.worker)?.flows ?? [], max, opts.color)
			: []),
	]);
	return [header(view, max, opts.color), ...rows].join("\n");
}

/** Bytes that replace the previous `prevLines`-line frame with `text` (cursor up, clear to end). */
export function frameBytes(prevLines: number, text: string): string {
	return prevLines > 0 ? `\u001b[${prevLines}A\r\u001b[0J${text}\n` : `${text}\n`;
}

/** An in-place redrawing region on a terminal-like sink. */
export type LiveScreen = { draw: (text: string) => void; end: (text: string) => void };

/** Redraw frames over each other on `write` (hides the cursor until `end`). */
export function liveScreen(write: (data: string) => void): LiveScreen {
	let lines = 0;
	let started = false;
	const draw = (text: string) => {
		write(`${started ? "" : "\u001b[?25l"}${frameBytes(lines, text)}`);
		started = true;
		lines = text.split("\n").length;
	};
	return {
		draw,
		end: (text) => {
			draw(text);
			write("\u001b[?25h");
		},
	};
}

/** `12.4 s` under a minute, `1m5s` above: what a log line says a job took. */
function took(ms: number): string {
	return ms < 60_000 ? `${(Math.max(0, ms) / 1_000).toFixed(1)} s` : formatDuration(ms);
}

/**
 * `--no-tui` / not a TTY: one log line per job start / end and the final tally (idle is quiet).
 * Each line is `[03/30] <device> ▶ <job>` / `✓ <job> (12.4 s)` / `✗ <job> exit N (12.4 s)`, where 03/30 is
 * the job's place in start order out of all jobs.
 */
export function plainLine(view: BatchView, event: BatchEvent): string | undefined {
	const width = String(view.total).length;
	const tag = (worker: number, job: string) => {
		const n = String(view.ordinals[job] ?? 0).padStart(width, "0");
		const [first, ...rest] = view.devices.filter((d) => d.worker === worker);
		return `[${n}/${view.total}] ${first?.name ?? "?"}${rest.length > 0 ? ` +${rest.length}` : ""}`;
	};
	switch (event.type) {
		case "job-start":
			return `${tag(event.worker, event.job)} ▶ ${event.job}${event.attempt > 0 ? ` (retry ${event.attempt})` : ""}`;
		case "job-end": {
			const duration = took(event.endedAt - event.startedAt);
			if (event.exitCode === 0) return `${tag(event.worker, event.job)} ✓ ${event.job} (${duration})`;
			return `${tag(event.worker, event.job)} ✗ ${event.job} exit ${event.exitCode} (${duration})${event.willRetry ? " retrying" : ""}`;
		}
		case "worker-idle":
			return undefined;
		case "done": {
			const { passed, failed } = totals(view);
			return `warden batch: ${passed}/${view.total} passed, ${failed} failed${event.stopped ? " (stopped)" : ""}`;
		}
	}
}
