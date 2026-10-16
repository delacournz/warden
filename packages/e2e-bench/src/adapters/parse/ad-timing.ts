import type { StepResult } from "../../results/schema";

/** One finished action of a replayed `.ad` script, from a `replay_action_stop` event. */
type ActionStop = { line: number; command: string; ok: boolean; durationMs: number };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One ndjson line → an action stop, or undefined for every other event type and for invalid JSON. */
function actionStop(line: string): ActionStop | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(raw) || raw.type !== "replay_action_stop") return undefined;
	const { line: scriptLine, command, ok, durationMs } = raw;
	if (typeof scriptLine !== "number" || typeof command !== "string") return undefined;
	if (typeof ok !== "boolean" || typeof durationMs !== "number") return undefined;
	return { line: scriptLine, command, ok, durationMs };
}

/**
 * `replay-timing.ndjson` (one per test attempt) → steps. agent-device redacts the arguments in the timing
 * events (`positionals: ["<arg>"]`), so the label is the script's own source line, 1-based `line` from the
 * event looked up in `script`. A step that failed carries status `failed`; steps never reached are absent.
 */
export function parseAdTiming(ndjson: string, script: string): StepResult[] {
	const lines = script.split(/\r?\n/);
	const steps: StepResult[] = [];
	for (const raw of ndjson.split("\n")) {
		const stop = actionStop(raw);
		if (stop === undefined) continue;
		const source = lines[stop.line - 1]?.trim();
		steps.push({
			kind: stop.command,
			label: source !== undefined && source !== "" ? source : stop.command,
			ms: stop.durationMs,
			status: stop.ok ? "passed" : "failed",
		});
	}
	return steps;
}
