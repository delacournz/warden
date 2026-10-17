import { type FlowMark, type FlowTracker, flowTracker, type TrackedFlow, testLine } from "./flow-progress";
import { createResultsTail, type ParseLine, type ReadFrom, type ResultsTail } from "./results-tail";

/** how often the jobs' `results.jsonl` are looked at for new tests */
export const FLOW_POLL_MS = 1_000;

/** Where the poller reports: the grid's marks for a worker's runner, and finished tests as log lines. */
export type FlowSink = {
	flows: (worker: number, marks: Readonly<Record<string, FlowMark>>) => void;
	tests: (lines: readonly string[]) => void;
};

export type FlowPollerDeps = {
	/** run `fn` every `ms` until the returned stop is called */
	every: (ms: number, fn: () => void) => () => void;
	readFrom: ReadFrom;
	/** one `results.jsonl` line → its result (default: JSON + the result schema) */
	parse?: ParseLine;
};

/** What the poller knows of one job attempt's results file. */
type Followed = { path: string; tail: ResultsTail; tracker: FlowTracker; finalSent: boolean };

/**
 * Follow the `results.jsonl` of every job started so far (`resultFiles` fills as jobs start; a key
 * is `<worker>:<seq>`): hand the flows they report finished to the sink (a job's flows count as
 * passed once it has `ended`) and each new test as one line.
 *
 * Each file is read from the byte after the last complete line it gave, so a line is parsed once
 * and the work per tick is proportional to what was added, not to the whole run. The sink hears
 * about a file only when its marks can have changed: a new result, a replaced file, or its job ending.
 * A job counts as ended only if it had before the look began, so that look saw everything it wrote.
 *
 * `poll` looks once (also called after the run, so the last results land; it waits for a look that
 * is already under way and then makes its own); `stop` ends the timer.
 */
export function flowPoller(
	deps: FlowPollerDeps,
	flows: readonly TrackedFlow[],
	resultFiles: ReadonlyMap<string, string>,
	ended: ReadonlySet<string>,
	sink: FlowSink
): { poll: () => Promise<void>; stop: () => void } {
	const followed = new Map<string, Followed>();
	const settled = new Set<string>();
	const follow = (key: string, path: string): Followed => {
		const known = followed.get(key);
		// a later pass of the attempt writes its own file (`…-p<k>`): follow that one from its start
		if (known?.path === path) return known;
		const entry: Followed = {
			path,
			tail: createResultsTail(path, deps.readFrom, deps.parse),
			tracker: flowTracker(flows),
			finalSent: false,
		};
		followed.set(key, entry);
		return entry;
	};
	const pollOne = async (key: string, path: string) => {
		const entry = follow(key, path);
		const final = ended.has(key);
		const { results, reset } = await entry.tail.poll();
		if (reset) entry.tracker.reset();
		entry.tracker.add(results);
		if (results.length > 0 || reset || (final && !entry.finalSent)) {
			sink.flows(Number(key.split(":")[0]), entry.tracker.marks(final));
			entry.finalSent = final;
		}
		const lines = results.flatMap((result) => {
			const flow = entry.tracker.flowOf(result);
			return flow ? [testLine(flow.id, result)] : [];
		});
		if (lines.length > 0) sink.tests(lines);
		if (final) settled.add(key);
	};
	const look = async () => {
		for (const [key, path] of resultFiles) if (!settled.has(key)) await pollOne(key, path);
	};
	let underway: Promise<void> | undefined;
	const poll = async () => {
		while (underway) await underway;
		underway = look().finally(() => {
			underway = undefined;
		});
		await underway;
	};
	const stop = deps.every(FLOW_POLL_MS, () => {
		if (!underway) void poll();
	});
	return { poll, stop };
}
