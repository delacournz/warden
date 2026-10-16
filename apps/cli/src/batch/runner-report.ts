import { readResults } from "@delacour/warden-e2e/runner/results";
import { type FlowMark, failing, flowOf, realPath, type TrackedFlow } from "./flow-progress";

/** What a run's `results.jsonl` files say: each flow's verdict, and the flows each device ran. */
export type RunnerReport = {
	flows: Record<string, FlowMark>;
	/** udid → the flows it ran, in result order, each marked by that device's tests */
	devices: Record<string, Array<{ id: string; mark: FlowMark }>>;
};

/** Mark `id` on `device`: a flow appears once per device, a failure sticks. */
function markDevice(devices: RunnerReport["devices"], device: string, id: string, mark: FlowMark): void {
	const ran = devices[device] ?? [];
	devices[device] = ran;
	const seen = ran.find((f) => f.id === id);
	if (!seen) ran.push({ id, mark });
	else if (mark === "failed") seen.mark = "failed";
}

/**
 * The finished run's results (every job's `results.jsonl`, concatenated) as the grid's report. A
 * flow fails if any of its tests failed or timed out; skipped tests count as passed. Results of
 * files not tracked, started before `since`, or without a valid line are ignored; no usable result
 * at all gives `undefined`.
 */
export function resultsReport(
	jsonl: string,
	flows: readonly TrackedFlow[],
	since: number,
	real: (path: string) => string = realPath
): RunnerReport | undefined {
	const report: RunnerReport = { flows: {}, devices: {} };
	let seen = false;
	for (const result of readResults(jsonl)) {
		const flow = flowOf(result, flows, real);
		if (!flow || result.startedAt < since) continue;
		seen = true;
		const mark: FlowMark = failing(result) ? "failed" : "passed";
		if (report.flows[flow.id] !== "failed") report.flows[flow.id] = mark;
		markDevice(report.devices, result.device.udid, flow.id, mark);
	}
	return seen ? report : undefined;
}
