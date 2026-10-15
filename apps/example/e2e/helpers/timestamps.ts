import { writeSync } from "node:fs";
import type { Reporter, RunEvent, RunEventOf } from "e2e";

type SetupStep = RunEventOf<"setup">["step"];
type TestKey = Pick<RunEventOf<"test-started">, "testId" | "target" | "agent" | "repeat">;
type Running = { startedAt: number; name: string; depth: number };

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** `d` as local `HH:MM:SS.mmm` (the same clock warden stamps its logs with). */
const clockOf = (d: Date): string =>
	`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

const keyOf = (k: TestKey): string => `${k.testId}|${k.target}|${k.agent}|${k.repeat}`;

/** `e2e/sign-in.e2e.ts` → `sign-in`: tags step lines, which interleave across workers. */
const shortName = (file: string): string => (file.split("/").pop() ?? file).replace(/\.e2e\.[cm]?[jt]sx?$/, "");

function setupLabel(step: SetupStep): string {
	switch (step.kind) {
		case "collect":
			return "collect";
		case "prepare":
			return `prepare ${step.target}`;
		case "service":
		case "app":
			return `${step.kind} ${step.label}`;
		default:
			return "step";
	}
}

type TestFinished = RunEventOf<"test-finished">;
type Step = RunEventOf<"step">;

const runLine = (event: RunEvent): string | undefined => {
	switch (event.type) {
		case "run-started":
			return `⏵ run started (${event.targets.join(", ")})`;
		case "run-finished":
			return `⏹ run finished ${event.status} (exit ${event.exitCode})`;
		case "run-interrupted":
			return `⏹ run interrupted (${event.mode})`;
		case "setup":
			return event.state === "started"
				? `⏵ setup ${setupLabel(event.step)}`
				: `⏹ setup ${setupLabel(event.step)} ${seconds(event.durationMs)}${event.outcome ? ` (${event.outcome})` : ""}`;
		default:
			return undefined;
	}
};

/** `■` line; duration from its `test-started`, else the attempts' own; device from the last attempt. */
function finishedLine(event: TestFinished & { at: string }, run: Running | undefined): string {
	const r = event.result;
	const ms = run ? Date.parse(event.at) - run.startedAt : r.attempts.reduce((sum, a) => sum + a.durationMs, 0);
	const device = r.attempts.at(-1)?.environment?.device;
	return `■ test |${r.target.name}| ${r.test.file} › ${r.test.title} ${r.status} ${seconds(ms)}${device ? ` on ${device}` : ""}`;
}

/** `▸` / `▪` line for a step's start / end, indented by nesting depth (tracked on `run`). */
function stepLine(event: Step, run: Running | undefined): string | undefined {
	const p = event.progress;
	if (p.phase !== "start" && p.phase !== "end") return undefined;
	const name = run?.name ?? event.testId;
	const what = `${p.kind} ${p.label || p.api}`;
	const depth = run?.depth ?? 0;
	if (p.phase === "start") {
		if (run) run.depth = depth + 1;
		return `${"  ".repeat(depth + 1)}▸ ${name} › ${what}`;
	}
	const after = Math.max(0, depth - 1);
	if (run) run.depth = after;
	const error = p.error ? ` — ${p.error.message}` : "";
	return `${"  ".repeat(after + 1)}▪ ${name} › ${what} ${p.status} ${p.durationMs}ms${error}`;
}

/**
 * Turns run events into log lines: run / setup boundaries, `▶`/`■` for each test and `▸`/`▪` for each
 * step (nested steps indented). `clock` prefixes the event's own time; off when warden already stamps
 * the log. Returns `undefined` for events it doesn't print (incl. the end of a test skipped without starting). Stateful: one per run.
 */
export function createEventFormatter(opts: { clock: boolean }): (event: RunEvent) => string | undefined {
	const running = new Map<string, Running>();

	function text(event: RunEvent): string | undefined {
		if (event.type === "test-started") {
			running.set(keyOf(event), { startedAt: Date.parse(event.at), name: shortName(event.file), depth: 0 });
			return `▶ test |${event.target}| ${event.file} › ${event.title}`;
		}
		if (event.type === "test-finished") {
			const r = event.result;
			const key = keyOf({ testId: r.test.id, target: r.target.name, agent: r.agent, repeat: r.repeat });
			const run = running.get(key);
			running.delete(key);
			if (!run && r.status === "skipped") return undefined;
			return finishedLine(event, run);
		}
		if (event.type === "step") return stepLine(event, running.get(keyOf(event)));
		return runLine(event);
	}

	return (event) => {
		const line = text(event);
		if (line === undefined) return undefined;
		return opts.clock ? `[${clockOf(new Date(event.at))}] ${line}` : line;
	};
}

/**
 * Always-on reporter beside `list`: prints when each test and step starts and ends, so a runner log
 * shows timing and overlap across devices. Under warden (`WARDEN_LOG_TIMESTAMPS=1`) every log line is
 * already stamped, so it skips its own clock. Built lazily: workers load the config too.
 */
export function timestampsReporter(env: Record<string, string | undefined> = process.env): Reporter {
	let format: ((event: RunEvent) => string | undefined) | undefined;
	return {
		name: "timestamps",
		onEvent(event) {
			try {
				format ??= createEventFormatter({ clock: env.WARDEN_LOG_TIMESTAMPS !== "1" });
				const line = format(event);
				// fd 1 directly: `list` captures `process.stdout` writes as `stdout | runner` blocks
				if (line !== undefined) writeSync(1, `${line}\n`);
			} catch {
				// a throw would quarantine the reporter for the rest of the run
			}
		},
	};
}
