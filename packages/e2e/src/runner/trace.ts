import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type TraceEvent, traceEventSchema } from "@delacour/warden-driver/trace/trace-event";
import type { TestResult } from "./results";

export type TraceWriter = {
	readonly path: string;
	/**
	 * Appends `event`. A `span` is only buffered (a test makes hundreds of driver calls and one `appendFileSync`
	 * each would show up in the timings it measures): the buffer is appended, in order, before the next other
	 * event, by {@link TraceWriter.flush}, or when it holds {@link SPAN_BUFFER_MAX} spans.
	 */
	write(event: TraceEvent): void;
	/** Appends the buffered spans; the runner calls it when an attempt ends. Spans written after it are lost. */
	flush(): void;
};

/** Spans held in memory before they are appended without waiting for a step. */
export const SPAN_BUFFER_MAX = 256;

class JsonlTraceWriter implements TraceWriter {
	private ready = false;
	private pending: string[] = [];

	constructor(
		readonly path: string,
		private readonly mirror?: (event: TraceEvent) => void
	) {}

	write(event: TraceEvent): void {
		const line = `${JSON.stringify(event)}\n`;
		if (event.type === "span") {
			this.pending.push(line);
			if (this.pending.length >= SPAN_BUFFER_MAX) this.flush();
		} else {
			const lines = this.pending;
			this.pending = [];
			this.append([...lines, line]);
		}
		this.mirror?.(event);
	}

	flush(): void {
		if (this.pending.length === 0) return;
		const lines = this.pending;
		this.pending = [];
		this.append(lines);
	}

	private append(lines: readonly string[]): void {
		if (!this.ready) {
			mkdirSync(dirname(this.path), { recursive: true });
			this.ready = true;
		}
		appendFileSync(this.path, lines.join(""));
	}
}

export class TraceFile {
	/** Append-only `trace.jsonl`; `mirror` also receives each event (the console reporter). */
	open(path: string, mirror?: (event: TraceEvent) => void): TraceWriter {
		return new JsonlTraceWriter(path, mirror);
	}

	/** Valid events in file order; blank, truncated and invalid lines are skipped. */
	read(text: string): TraceEvent[] {
		const events: TraceEvent[] = [];
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			let json: unknown;
			try {
				json = JSON.parse(line);
			} catch {
				continue;
			}
			const parsed = traceEventSchema.safeParse(json);
			if (parsed.success) events.push(parsed.data);
		}
		return events;
	}
}

export const traceFile = new TraceFile();

type TestRef = Pick<TestResult, "file" | "title" | "device">;

/** What the console reporter prints: a trace event, or a test boundary. */
export type ConsoleEvent =
	| TraceEvent
	| { type: "test-start"; test: TestRef & { startedAt: number } }
	| { type: "test-end"; result: TestResult };

export type ConsoleLineOptions = {
	/** prefix `[HH:MM:SS.mmm] `; false under `WARDEN_LOG_TIMESTAMPS=1` (warden stamps the log) */
	clock: boolean;
	/** step lines only: short spec name tagging the line (steps interleave across workers) */
	short?: string;
	/** step lines only: nesting depth, 0 = directly in the test */
	depth?: number;
};

export class ConsoleLines {
	/** `ts` as local `HH:MM:SS.mmm` (the clock warden stamps its logs with). */
	clockOf(ts: number): string {
		const d = new Date(ts);
		return `${this.pad(d.getHours())}:${this.pad(d.getMinutes())}:${this.pad(d.getSeconds())}.${this.pad(d.getMilliseconds(), 3)}`;
	}

	/** `e2e/sign-in.e2e.ts` → `sign-in`. */
	shortName(file: string): string {
		return (file.split("/").pop() ?? file).replace(/\.e2e\.[cm]?[jt]sx?$/, "").replace(/\.[cm]?[jt]sx?$/, "");
	}

	/**
	 * The console line for an event, in PR #22's convention: `▶ test |<platform>| <file> › <title>` /
	 * `■ … <status> <N.NN>s on <device>` per test, `▸`/`▪` per step. `undefined` for events that print
	 * nothing (`screenshot`, `note`).
	 */
	format(event: ConsoleEvent, opts: ConsoleLineOptions): string | undefined {
		const line = this.lineOf(event, opts);
		if (line === undefined) return undefined;
		return opts.clock ? `[${this.clockOf(line.ts)}] ${line.text}` : line.text;
	}

	private pad(n: number, width = 2): string {
		return String(n).padStart(width, "0");
	}

	private deviceLabel(device: TestRef["device"]): string {
		return device.name ?? (device.udid.length > 9 ? `${device.udid.slice(0, 9)}…` : device.udid);
	}

	private testName(test: TestRef): string {
		return `${test.file} › ${test.title.join(" › ")}`;
	}

	private lineOf(event: ConsoleEvent, opts: ConsoleLineOptions): { ts: number; text: string } | undefined {
		const short = opts.short ?? "test";
		const indent = "  ".repeat((opts.depth ?? 0) + 1);
		switch (event.type) {
			case "test-start":
				return {
					ts: event.test.startedAt,
					text: `▶ test |${event.test.device.platform}| ${this.testName(event.test)}`,
				};
			case "test-end": {
				const r = event.result;
				return {
					ts: r.startedAt + r.durationMs,
					text: `■ test |${r.device.platform}| ${this.testName(r)} ${r.status} ${(r.durationMs / 1000).toFixed(2)}s on ${this.deviceLabel(r.device)}`,
				};
			}
			case "step-start":
				return { ts: event.ts, text: `${indent}▸ ${short} › ${event.kind} ${event.label}` };
			case "step-end": {
				const error = event.error ? ` — ${event.error}` : "";
				return {
					ts: event.ts,
					text: `${indent}▪ ${short} › ${event.kind} ${event.label} ${event.status} ${event.ms}ms${error}`,
				};
			}
			default:
				return undefined;
		}
	}
}

export const consoleLines = new ConsoleLines();
