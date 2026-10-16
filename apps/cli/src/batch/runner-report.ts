import type { FlowMark, TrackedFlow } from "./flow-progress";

/** What a `mode: "single"` runner's report says: each flow's verdict, and the flows each device ran. */
export type RunnerReport = {
	flows: Record<string, FlowMark>;
	/** udid → the flows it ran, in report order, each marked by that device's last attempt */
	devices: Record<string, Array<{ id: string; mark: FlowMark }>>;
};

type Attempt = { status?: unknown; environment?: { device?: unknown } };
type Result = { file?: unknown; status?: unknown; attempts?: unknown };

const FAILED = new Set(["failed", "interrupted", "timedOut", "error"]);

/** `passed`, or a failure (an interrupted test failed too); skipped / unknown statuses mark nothing. */
const markOf = (status: unknown): FlowMark | undefined =>
	status === "passed" ? "passed" : typeof status === "string" && FAILED.has(status) ? "failed" : undefined;

function parse(text: string): { startedAt: number; results: Result[] } | undefined {
	try {
		const doc: { run?: { startedAt?: unknown; results?: unknown } } = JSON.parse(text);
		const startedAt = typeof doc.run?.startedAt === "string" ? Date.parse(doc.run.startedAt) : Number.NaN;
		if (Number.isNaN(startedAt) || !Array.isArray(doc.run?.results)) return undefined;
		return { startedAt, results: doc.run.results };
	} catch {
		return undefined;
	}
}

/** Mark `id` on `device`: a flow appears once per device, a failure sticks. */
function markDevice(devices: RunnerReport["devices"], device: string, id: string, mark: FlowMark): void {
	const ran = devices[device] ?? [];
	devices[device] = ran;
	const seen = ran.find((f) => f.id === id);
	if (!seen) ran.push({ id, mark });
	else if (mark === "failed") seen.mark = "failed";
}

/**
 * Read tester.army `e2e run`'s `report.json` (`run.results[]`: one per test, with its `file`, `status`
 * and `attempts[].environment.device`). A flow fails if any of its tests did. Tests skipped, files not
 * tracked, and a report that started before `since` (a previous run's) are ignored.
 */
export function runnerReport(text: string, flows: readonly TrackedFlow[], since: number): RunnerReport | undefined {
	const doc = parse(text);
	if (!doc || doc.startedAt < since) return undefined;
	const report: RunnerReport = { flows: {}, devices: {} };
	for (const result of doc.results) {
		const flow = flows.find((f) => f.path === result.file);
		const mark = markOf(result.status);
		if (!flow || !mark) continue;
		if (report.flows[flow.id] !== "failed") report.flows[flow.id] = mark;
		for (const [device, am] of lastByDevice(result.attempts)) markDevice(report.devices, device, flow.id, am);
	}
	return report;
}

/** Each device's last attempt at one test. */
function lastByDevice(attempts: unknown): Map<string, FlowMark> {
	const last = new Map<string, FlowMark>();
	for (const a of Array.isArray(attempts) ? (attempts as Attempt[]) : []) {
		const device = a.environment?.device;
		const mark = markOf(a.status);
		if (typeof device === "string" && mark) last.set(device, mark);
	}
	return last;
}

/** Where the runner argv writes its report: `--output <dir>` / `--output=<dir>`, else e2e's `.e2e`; undefined when it varies per job. */
export function reportOutputDir(argv: readonly string[]): string | undefined {
	let dir = ".e2e";
	argv.forEach((arg, i) => {
		if (arg === "--output" && argv[i + 1] !== undefined) dir = argv[i + 1] ?? dir;
		else if (arg.startsWith("--output=")) dir = arg.slice("--output=".length);
	});
	return dir.includes("{") ? undefined : dir;
}
