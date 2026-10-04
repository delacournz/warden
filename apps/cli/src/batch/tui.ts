import type { BatchEvent } from "@delacour/warden-core/batch/schedule";
import { formatDuration } from "@delacour/warden-core/duration";

/** Live state of one device (= worker) in the batch grid. */
export type DeviceView = {
	worker: number;
	udid: string;
	name: string;
	current?: { job: string; startedAt: number; attempt: number };
	passed: number;
	failed: number;
	idle: boolean;
};

export type BatchView = {
	startedAt: number;
	now: number;
	total: number;
	devices: DeviceView[];
	/** job → its 1-based place in the order jobs started (retries keep their job's place) */
	ordinals: Record<string, number>;
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
		devices: devices.map((d) => ({ ...d, passed: 0, failed: 0, idle: false })),
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
			const next = update(event.worker, (d) => ({
				...d,
				idle: false,
				current: { job: event.job, startedAt: event.at, attempt: event.attempt },
			}));
			if (event.job in view.ordinals) return next;
			return { ...next, ordinals: { ...view.ordinals, [event.job]: Object.keys(view.ordinals).length + 1 } };
		}
		case "job-end":
			return update(event.worker, ({ current: _, ...d }) => ({
				...d,
				passed: d.passed + (event.exitCode === 0 ? 1 : 0),
				failed: d.failed + (event.exitCode !== 0 && !event.willRetry ? 1 : 0),
			}));
		case "worker-idle":
			return update(event.worker, ({ current: _, ...d }) => ({ ...d, idle: true }));
		case "done":
			return { ...view, now, result: { ok: event.ok, stopped: event.stopped } };
	}
}

function totals(view: BatchView): { passed: number; failed: number } {
	return view.devices.reduce((t, d) => ({ passed: t.passed + d.passed, failed: t.failed + d.failed }), {
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

function bar(fraction: number, width: number): string {
	const full = Math.round(Math.min(1, Math.max(0, fraction)) * width);
	return "█".repeat(full) + "░".repeat(width - full);
}

const BAR_WIDTH = 20;
const DEVICE_BAR_WIDTH = 8;
const NAME_WIDTH = 20;

function header(view: BatchView, max: number, color: boolean): string {
	const { passed, failed } = totals(view);
	const done = passed + failed;
	const state: Segment = view.result
		? view.result.ok
			? { text: "  ✓ done", style: "green" }
			: { text: view.result.stopped ? "  ✗ stopped" : "  ✗ failed", style: "red" }
		: { text: "" };
	return line(
		[
			{ text: "warden batch  ", style: "bold" },
			{ text: bar(view.total === 0 ? 1 : done / view.total, BAR_WIDTH), style: "cyan" },
			{ text: `  ${done}/${view.total}  ` },
			{ text: `✓${passed}`, style: "green" },
			{ text: " " },
			{ text: `✗${failed}`, style: failed > 0 ? "red" : "dim" },
			{ text: `  ${formatDuration(view.now - view.startedAt)}`, style: "dim" },
			state,
		],
		max,
		color
	);
}

type Columns = { id: number; name: number; job: number };

function deviceStatus(d: DeviceView, width: number): Segment {
	if (!d.current) return { text: pad(d.idle ? "· idle" : "· waiting", width), style: "dim" };
	const retry = d.current.attempt > 0 ? ` (retry ${d.current.attempt})` : "";
	return { text: pad(`▶ ${d.current.job}${retry}`, width), style: retry ? "yellow" : "cyan" };
}

function deviceRow(view: BatchView, d: DeviceView, cols: Columns, max: number, color: boolean): string {
	const elapsed = d.current ? formatDuration(view.now - d.current.startedAt) : "";
	return line(
		[
			{ text: `${String(d.worker).padStart(cols.id)} `, style: "dim" },
			{ text: pad(d.name, cols.name) },
			{ text: "  " },
			deviceStatus(d, cols.job),
			{ text: `  ${elapsed.padStart(6)}  `, style: "dim" },
			{ text: `✓${String(d.passed).padEnd(3)}`, style: "green" },
			{ text: " " },
			{ text: `✗${String(d.failed).padEnd(3)}`, style: d.failed > 0 ? "red" : "dim" },
			{ text: " " },
			{ text: bar(view.total === 0 ? 0 : (d.passed + d.failed) / view.total, DEVICE_BAR_WIDTH), style: "cyan" },
		],
		max,
		color
	);
}

/** The grid: a header (overall progress, ✓/✗, elapsed) + one row per device. Pure — no ANSI cursor moves. */
export function render(view: BatchView, opts: RenderOptions): string {
	const max = Math.max(10, opts.width - 1);
	const id = String(Math.max(0, ...view.devices.map((d) => d.worker))).length;
	const name = Math.min(NAME_WIDTH, Math.max(4, ...view.devices.map((d) => [...d.name].length)));
	const job = Math.max(8, max - (id + 1 + name + 2 + 2 + 7 + 2 + 9 + DEVICE_BAR_WIDTH));
	const rows = view.devices.map((d) => deviceRow(view, d, { id, name, job }, max, opts.color));
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
		return `[${n}/${view.total}] ${view.devices.find((d) => d.worker === worker)?.name ?? "?"}`;
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
