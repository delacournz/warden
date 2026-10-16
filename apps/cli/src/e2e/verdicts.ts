import type { SelectedFlow } from "@delacour/warden-core/affected/select";
import type { BatchSummary, JobResult } from "@delacour/warden-core/batch/schedule";
import { readResults, type TestResult, type TestStatus } from "@delacour/warden-e2e/runner/results";
import { failing, flowOf, realPath } from "../batch/flow-progress";
import { attemptKey, legJob, type SessionResult } from "../commands/batch";

/** One test of a flow, as `e2e-report.json` carries it. */
export type TestVerdict = {
	/** describe titles, then the test's */
	title: string[];
	status: TestStatus;
	durationMs: number;
	/** the failure message */
	error?: string;
	/** the attempt dir: `failure.png`, `screen-at-failure.txt`, `trace.jsonl`… */
	artifacts?: string;
};

/** One flow's outcome in `e2e-report.json`. */
export type FlowVerdict = SelectedFlow & {
	/** the device leg this verdict is for (suites with `devices`) */
	leg?: string;
	verdict: "passed" | "failed" | "not-run";
	attempts: number;
	/** the tests of the flow's last attempt (from `results.jsonl`; absent when the process wrote none) */
	tests?: TestVerdict[];
	/** the device the flow's last failed attempt ran on */
	device?: { udid: string; name: string };
	/** the spec process output of that attempt */
	log?: string;
	/** the device as the flow's last failed attempt left it (png), when one could be captured */
	screenshot?: string;
};

/** How the batch jobs map back to flows: the legs that ran, and in a `single` run the shard job each flow is in. */
export type RunShape = { legs: ReadonlyArray<string | undefined>; shardOf?: ReadonlyMap<string, string> };

export const ONE_LEG: RunShape = { legs: [undefined] };

export type VerdictIO = {
	readFile: (path: string) => Promise<string>;
	/** `CI` is set: a `test.only` left in a spec fails the run */
	ci: boolean;
	real?: (path: string) => string;
};

export type Verdicts = {
	ok: boolean;
	flows: FlowVerdict[];
	/** jobs whose verdict fell back to the exit code (no usable `results.jsonl`) */
	warnings: string[];
	/** spec files with a `test.only`, when `ci` */
	only: string[];
};

/** device / log / screenshot of a flow's failed attempts (the last one's device and log; the latest screenshot there is). */
function lastFailure(session: SessionResult, failed: readonly JobResult[]): Partial<FlowVerdict> {
	const last = failed.at(-1);
	if (!last) return {};
	const screenshot = failed
		.map((r) => session.screenshots?.get(attemptKey(r)))
		.reverse()
		.find((path) => path !== undefined);
	const log = session.logs?.get(attemptKey(last));
	const name = session.devices?.find((d) => d.worker === last.worker)?.name ?? last.udid;
	return {
		device: { udid: last.udid, name },
		...(log !== undefined ? { log } : {}),
		...(screenshot !== undefined ? { screenshot } : {}),
	};
}

const testVerdict = (t: TestResult): TestVerdict => ({
	title: t.title,
	status: t.status,
	durationMs: t.durationMs,
	...(t.error ? { error: t.error.message } : {}),
	...(t.artifacts ? { artifacts: t.artifacts.dir } : {}),
});

/** Reads and parses each `results.jsonl` once (several flows of a shard share one). */
function resultsLoader(io: VerdictIO) {
	const cache = new Map<string, Promise<TestResult[] | undefined>>();
	return (path: string): Promise<TestResult[] | undefined> => {
		const hit = cache.get(path);
		if (hit) return hit;
		const read = io.readFile(path).then(
			(text) => readResults(text),
			() => undefined
		);
		cache.set(path, read);
		return read;
	};
}

type Judged = { verdict: "passed" | "failed"; tests?: TestVerdict[]; fellBack: boolean };

/**
 * One flow's verdict from its job's last attempt. A failed or timed-out test fails the flow. A
 * non-zero exit fails it too, unless a test elsewhere in the job failed and this flow's own tests
 * passed (a `single` shard: the failure is that test's, not this flow's). Without any usable
 * result the exit code decides.
 */
function judge(all: readonly TestResult[] | undefined, mine: readonly TestResult[], exitCode: number): Judged {
	if (all === undefined || all.length === 0) return { verdict: exitCode === 0 ? "passed" : "failed", fellBack: true };
	const tests = mine.map(testVerdict);
	const blamed = all.some(failing);
	const failed = mine.some(failing) || (exitCode !== 0 && !(mine.length > 0 && blamed));
	return { verdict: failed ? "failed" : "passed", tests, fellBack: false };
}

type Run = {
	session: SessionResult;
	shape: RunShape;
	real: (path: string) => string;
	load: (path: string) => Promise<TestResult[] | undefined>;
	warnings: Set<string>;
	onlyFiles: Set<string>;
};

/** One flow on one leg: its job's attempts, then the verdict of the last one. */
async function flowVerdict(run: Run, flow: SelectedFlow, leg: string | undefined): Promise<FlowVerdict> {
	const { session, shape } = run;
	const job = legJob(shape.shardOf?.get(flow.id) ?? flow.id, shape.legs.length > 1 ? leg : undefined);
	const ran = (session.summary?.results ?? []).filter((r) => r.job === job);
	const last = ran.at(-1);
	const base = { ...flow, ...(leg !== undefined ? { leg } : {}), attempts: ran.length };
	if (!last) return { ...base, verdict: "not-run" };
	const path = session.resultFiles?.get(attemptKey(last));
	const all = path === undefined ? undefined : await run.load(path);
	for (const r of all ?? []) if (r.only) run.onlyFiles.add(r.file);
	const mine = (all ?? []).filter((r) => flowOf(r, [{ id: flow.id, path: flow.file }], run.real) !== undefined);
	const judged = judge(all, mine, last.exitCode);
	if (judged.fellBack) run.warnings.add(`${job}: no results.jsonl — verdict from exit code ${last.exitCode}`);
	const failure = lastFailure(
		session,
		ran.filter((r) => r.exitCode !== 0)
	);
	return { ...base, verdict: judged.verdict, ...(judged.tests ? { tests: judged.tests } : {}), ...failure };
}

/**
 * Batch outcome → per-flow verdicts (one per leg that ran) from every job's `results.jsonl`; `ok` =
 * every required flow passed on every leg and, under CI, no spec left a `test.only`. A job without
 * a usable results file falls back to its exit code (and is listed in `warnings`).
 */
export async function verdicts(
	flows: readonly SelectedFlow[],
	session: SessionResult,
	shape: RunShape,
	io: VerdictIO
): Promise<Verdicts> {
	const run: Run = {
		session,
		shape,
		real: io.real ?? realPath,
		load: resultsLoader(io),
		warnings: new Set(),
		onlyFiles: new Set(),
	};
	const out: FlowVerdict[] = [];
	for (const leg of shape.legs) for (const flow of flows) out.push(await flowVerdict(run, flow, leg));
	const only = io.ci ? [...run.onlyFiles] : [];
	const ok =
		session.summary !== undefined && only.length === 0 && out.every((f) => !f.required || f.verdict === "passed");
	return { ok, flows: out, warnings: [...run.warnings], only };
}

/** Exit-code-only gate (no files read): every required flow's job passed. Decides whether the sims are shut down. */
export function exitGate(flows: readonly SelectedFlow[], summary: BatchSummary, shape: RunShape): boolean {
	const failed = new Set(summary.failed);
	const qualified = shape.legs.length > 1;
	return flows.every(
		(flow) =>
			!flow.required ||
			shape.legs.every((leg) => {
				const job = legJob(shape.shardOf?.get(flow.id) ?? flow.id, qualified ? leg : undefined);
				return summary.results.some((r) => r.job === job) && !failed.has(job);
			})
	);
}
