import type { SelectedFlow } from "@delacour/warden-core/affected/select";
import type { BatchSummary, JobResult } from "@delacour/warden-core/batch/schedule";
import { readResults, type TestResult, type TestStatus } from "@delacour/warden-e2e/runner/results";
import { failing, flowOf, realPath } from "../batch/flow-progress";
import { runnerFailureShot } from "../batch/screenshot";
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
	/**
	 * The device at the flow's last failure (png), when one could be captured: the spec runner's
	 * `failure.png` of the failed test when it took one, else the device as the attempt left it.
	 */
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
	/**
	 * The flow ids each attempt (`attemptKey`) of a shard job ran, when a retry ran fewer flows than
	 * the first attempt did. An attempt not listed ran every flow of its job.
	 */
	attempts?: ReadonlyMap<string, ReadonlySet<string>>;
};

export type Verdicts = {
	ok: boolean;
	flows: FlowVerdict[];
	/** jobs whose verdict fell back to the exit code (no usable `results.jsonl`) */
	warnings: string[];
	/** spec files with a `test.only`, when `ci` */
	only: string[];
};

/**
 * device / log / screenshot of a flow's failed attempts (the last one's device and log; the latest
 * screenshot there is, per attempt the runner's own `failure.png` of this flow before the batch shot).
 */
function lastFailure(
	session: SessionResult,
	failed: readonly JobResult[],
	runnerShots: ReadonlyMap<JobResult, string> = new Map()
): Partial<FlowVerdict> {
	const last = failed.at(-1);
	if (!last) return {};
	const screenshot = failed
		.map((r) => runnerShots.get(r) ?? session.screenshots?.get(attemptKey(r)))
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

export type Judged = {
	verdict: "passed" | "failed";
	tests?: TestVerdict[];
	fellBack: boolean;
	/** the runner's `failure.png` of this flow's failed test in the attempt */
	shot?: string;
};

/**
 * Each flow's verdict from one attempt of its job (a spec process over `jobFlows`: one flow, or a
 * device's shard). A failed or timed-out test fails its flow. Without any usable result the exit
 * code decides every flow. After that, a non-zero exit means:
 * - a flow with no result of its own failed (the process never got to it);
 * - if the process stopped before every flow had a result (a crash, a kill, a timeout), the flow
 *   whose result came last was running when it died, so it fails, and the flows before it passed;
 * - if every flow has a result, a failed test elsewhere is to blame and the flows whose tests passed
 *   pass; with no failed test anywhere the process itself failed and so does every flow.
 */
export function judgeJob(
	jobFlows: readonly SelectedFlow[],
	all: readonly TestResult[] | undefined,
	exitCode: number,
	real: (path: string) => string
): Map<string, Judged> {
	const judged = new Map<string, Judged>();
	if (all === undefined || all.length === 0) {
		for (const flow of jobFlows) judged.set(flow.id, { verdict: exitCode === 0 ? "passed" : "failed", fellBack: true });
		return judged;
	}
	const tracked = jobFlows.map((f) => ({ id: f.id, path: f.file }));
	const byFlow = new Map<string, TestResult[]>();
	for (const r of all) {
		const owner = flowOf(r, tracked, real);
		if (owner) byFlow.set(owner.id, [...(byFlow.get(owner.id) ?? []), r]);
	}
	const lastResult = all.at(-1);
	const lastFlow = lastResult ? flowOf(lastResult, tracked, real)?.id : undefined;
	const blamed = all.some(failing);
	const stoppedEarly = jobFlows.some((f) => !byFlow.has(f.id));
	for (const flow of jobFlows) {
		const mine = byFlow.get(flow.id) ?? [];
		const failed =
			mine.some(failing) || (exitCode !== 0 && (mine.length === 0 || (stoppedEarly ? flow.id === lastFlow : !blamed)));
		const shot = failed ? runnerFailureShot(mine) : undefined;
		judged.set(flow.id, {
			verdict: failed ? "failed" : "passed",
			tests: mine.map(testVerdict),
			fellBack: false,
			...(shot !== undefined ? { shot } : {}),
		});
	}
	return judged;
}

type Run = {
	session: SessionResult;
	shape: RunShape;
	real: (path: string) => string;
	load: (path: string) => Promise<TestResult[] | undefined>;
	attempts: ReadonlyMap<string, ReadonlySet<string>>;
	/** the flows of each job, by qualified job name */
	jobFlows: ReadonlyMap<string, readonly SelectedFlow[]>;
	judgements: Map<string, Promise<Map<string, Judged>>>;
	warnings: Set<string>;
	onlyFiles: Set<string>;
};

/** One attempt of `job` judged for every flow it ran (once per attempt). */
function judgeAttempt(run: Run, job: string, attempt: JobResult): Promise<Map<string, Judged>> {
	const key = attemptKey(attempt);
	const known = run.judgements.get(key);
	if (known) return known;
	const ranIds = run.attempts.get(key);
	const flows = (run.jobFlows.get(job) ?? []).filter((f) => ranIds === undefined || ranIds.has(f.id));
	const path = run.session.resultFiles?.get(key);
	const judged = (path === undefined ? Promise.resolve(undefined) : run.load(path)).then((all) => {
		for (const r of all ?? []) if (r.only) run.onlyFiles.add(r.file);
		const out = judgeJob(flows, all, attempt.exitCode, run.real);
		if ([...out.values()].some((j) => j.fellBack))
			run.warnings.add(`${job}: no results.jsonl — verdict from exit code ${attempt.exitCode}`);
		return out;
	});
	run.judgements.set(key, judged);
	return judged;
}

/** The attempts that failed `flow` (a non-zero exit it did not pass), with the runner's own failure shot of each. */
async function failedAttempts(run: Run, job: string, flow: SelectedFlow, ran: readonly JobResult[]) {
	const failedRuns: JobResult[] = [];
	const runnerShots = new Map<JobResult, string>();
	for (const r of ran) {
		if (r.exitCode === 0) continue;
		const mine = (await judgeAttempt(run, job, r)).get(flow.id);
		if (mine?.verdict === "passed") continue;
		failedRuns.push(r);
		if (mine?.shot !== undefined) runnerShots.set(r, mine.shot);
	}
	return { failedRuns, runnerShots };
}

/** One flow on one leg: the attempts of its job that ran it, then the verdict of the last of them. */
async function flowVerdict(run: Run, flow: SelectedFlow, leg: string | undefined): Promise<FlowVerdict> {
	const { session, shape } = run;
	const job = legJob(shape.shardOf?.get(flow.id) ?? flow.id, shape.legs.length > 1 ? leg : undefined);
	const ran = (session.summary?.results ?? [])
		.filter((r) => r.job === job)
		.filter((r) => run.attempts.get(attemptKey(r))?.has(flow.id) ?? true);
	const last = ran.at(-1);
	const base = { ...flow, ...(leg !== undefined ? { leg } : {}), attempts: ran.length };
	if (!last) return { ...base, verdict: "not-run" };
	const judged = (await judgeAttempt(run, job, last)).get(flow.id);
	const { failedRuns, runnerShots } = await failedAttempts(run, job, flow, ran);
	return {
		...base,
		verdict: judged?.verdict ?? "failed",
		...(judged?.tests && !judged.fellBack ? { tests: judged.tests } : {}),
		...lastFailure(session, failedRuns, runnerShots),
	};
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
	const jobFlows = new Map<string, SelectedFlow[]>();
	for (const leg of shape.legs) {
		for (const flow of flows) {
			const job = legJob(shape.shardOf?.get(flow.id) ?? flow.id, shape.legs.length > 1 ? leg : undefined);
			jobFlows.set(job, [...(jobFlows.get(job) ?? []), flow]);
		}
	}
	const run: Run = {
		session,
		shape,
		real: io.real ?? realPath,
		load: resultsLoader(io),
		attempts: io.attempts ?? new Map(),
		jobFlows,
		judgements: new Map(),
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
