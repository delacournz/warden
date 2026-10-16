import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { TestResult } from "./results";

const base = { ts: z.number(), kind: z.string(), label: z.string() };

export const traceEventSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("step-start"), ...base }),
	z.object({
		type: z.literal("step-end"),
		...base,
		status: z.enum(["passed", "failed"]),
		ms: z.number(),
		error: z.string().optional(),
	}),
	z.object({ type: z.literal("screenshot"), ...base, path: z.string() }),
	z.object({ type: z.literal("note"), ...base }),
]);

/** One line of `trace.jsonl`; `ts` is epoch ms, `kind` the step family (`app`, `locator`, `expect`, …). */
export type TraceEvent = z.infer<typeof traceEventSchema>;

export type TraceWriter = {
	readonly path: string;
	write(event: TraceEvent): void;
};

/** Append-only `trace.jsonl`; `mirror` also receives each event (the console reporter). */
export function openTrace(path: string, mirror?: (event: TraceEvent) => void): TraceWriter {
	let ready = false;
	return {
		path,
		write(event) {
			if (!ready) {
				mkdirSync(dirname(path), { recursive: true });
				ready = true;
			}
			appendFileSync(path, `${JSON.stringify(event)}\n`);
			mirror?.(event);
		},
	};
}

/** Valid events in file order; blank, truncated and invalid lines are skipped. */
export function readTrace(text: string): TraceEvent[] {
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

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** `ts` as local `HH:MM:SS.mmm` (the clock warden stamps its logs with). */
export function clockOf(ts: number): string {
	const d = new Date(ts);
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** `e2e/sign-in.e2e.ts` → `sign-in`. */
export function shortName(file: string): string {
	return (file.split("/").pop() ?? file).replace(/\.e2e\.[cm]?[jt]sx?$/, "").replace(/\.[cm]?[jt]sx?$/, "");
}

const deviceLabel = (device: TestRef["device"]): string =>
	device.name ?? (device.udid.length > 9 ? `${device.udid.slice(0, 9)}…` : device.udid);

const testName = (test: TestRef): string => `${test.file} › ${test.title.join(" › ")}`;

function lineOf(event: ConsoleEvent, opts: ConsoleLineOptions): { ts: number; text: string } | undefined {
	const short = opts.short ?? "test";
	const indent = "  ".repeat((opts.depth ?? 0) + 1);
	switch (event.type) {
		case "test-start":
			return { ts: event.test.startedAt, text: `▶ test |${event.test.device.platform}| ${testName(event.test)}` };
		case "test-end": {
			const r = event.result;
			return {
				ts: r.startedAt + r.durationMs,
				text: `■ test |${r.device.platform}| ${testName(r)} ${r.status} ${(r.durationMs / 1000).toFixed(2)}s on ${deviceLabel(r.device)}`,
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

/**
 * The console line for an event, in PR #22's convention: `▶ test |<platform>| <file> › <title>` /
 * `■ … <status> <N.NN>s on <device>` per test, `▸`/`▪` per step. `undefined` for events that print
 * nothing (`screenshot`, `note`).
 */
export function formatConsoleLine(event: ConsoleEvent, opts: ConsoleLineOptions): string | undefined {
	const line = lineOf(event, opts);
	if (line === undefined) return undefined;
	return opts.clock ? `[${clockOf(line.ts)}] ${line.text}` : line.text;
}
