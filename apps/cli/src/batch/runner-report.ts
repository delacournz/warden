import { readResults } from "@delacour/warden-e2e/runner/results";
import { failing, realPath, type SpecMark, specOf, type TrackedSpec } from "./spec-progress";

/** What a run's `results.jsonl` files say: each spec's verdict, and the specs each device ran. */
export type RunnerReport = {
	specs: Record<string, SpecMark>;
	/** udid → the specs it ran, in result order, each marked by that device's tests */
	devices: Record<string, Array<{ id: string; mark: SpecMark }>>;
};

/** `id`'s mark on `udid`, set in the order specs first appeared on that device. */
type DeviceMarks = Map<string, Map<string, SpecMark>>;

/**
 * One attempt's results folded into `marks`. Within the attempt a failure sticks (a spec fails if
 * any of its tests did); a later attempt then replaces the mark the earlier one left for the same
 * spec on the same device, since a retry runs on the device that failed.
 */
function foldAttempt(
	marks: DeviceMarks,
	jsonl: string,
	specs: readonly TrackedSpec[],
	since: number,
	real: (path: string) => string
): void {
	const attempt: DeviceMarks = new Map();
	for (const result of readResults(jsonl)) {
		const spec = specOf(result, specs, real);
		if (!spec || result.startedAt < since) continue;
		const ran = attempt.get(result.device.udid) ?? new Map<string, SpecMark>();
		attempt.set(result.device.udid, ran);
		if (ran.get(spec.id) !== "failed") ran.set(spec.id, failing(result) ? "failed" : "passed");
	}
	for (const [udid, ran] of attempt) {
		const device = marks.get(udid) ?? new Map<string, SpecMark>();
		marks.set(udid, device);
		for (const [id, mark] of ran) device.set(id, mark);
	}
}

/**
 * The finished run's results as the grid's report. `attempts` are the jobs' `results.jsonl` texts
 * (a single text is one attempt), in the order the attempts ran: a spec's mark on a device is the
 * last attempt's, so a spec that failed and then passed on its retry is passed. A spec fails if any
 * device ended it failed (device legs run every spec on each of their devices) and within one
 * attempt if any of its tests failed or timed out; skipped tests count as passed. Results of files
 * not tracked, started before `since`, or without a valid line are ignored; no usable result at all
 * gives `undefined`.
 */
export function resultsReport(
	attempts: string | readonly string[],
	specs: readonly TrackedSpec[],
	since: number,
	real: (path: string) => string = realPath
): RunnerReport | undefined {
	const marks: DeviceMarks = new Map();
	for (const jsonl of typeof attempts === "string" ? [attempts] : attempts)
		foldAttempt(marks, jsonl, specs, since, real);
	if (marks.size === 0) return undefined;
	const report: RunnerReport = { specs: {}, devices: {} };
	for (const [udid, ran] of marks) {
		report.devices[udid] = [...ran].map(([id, mark]) => ({ id, mark }));
		for (const [id, mark] of ran) if (report.specs[id] !== "failed") report.specs[id] = mark;
	}
	return report;
}
