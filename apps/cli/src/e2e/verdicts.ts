import { join } from "node:path";
import type { SelectedSpec } from "@delacour/warden-core/affected/select";
import type { BatchSummary, JobResult } from "@delacour/warden-core/batch/schedule";
import { readResults, type TestResult, type TestStatus } from "@delacour/warden-e2e/runner/results";
import { runnerFailureShot } from "../batch/screenshot";
import { failing, realPath, specOf } from "../batch/spec-progress";
import { attemptKey, legJob, type SessionResult } from "../commands/batch";

/** One test of a spec, as `e2e-report.json` carries it. */
export type TestVerdict = {
	/** describe titles, then the test's */
	title: string[];
	status: TestStatus;
	durationMs: number;
	/** the failure message */
	error?: string;
	/** the attempt dir: `failure.png`, `screen-at-failure.txt`, `trace.jsonl`… */
	artifacts?: string;
	/** `device.perf` / `--perf` wrote a report: `<artifacts>/perf` (`report.json`, `report.md`, `session.json`) */
	perf?: string;
	/** the test failed because a perf metric was over its budget (`error` lists metric, value, budget and the report) */
	kind?: "perf_budget";
};

/** One spec's outcome in `e2e-report.json`. */
export type SpecVerdict = SelectedSpec & {
	/** the device leg this verdict is for (suites with `devices`) */
	leg?: string;
	verdict: "passed" | "failed" | "not-run";
	attempts: number;
	/** the tests of the spec's last attempt (from `results.jsonl`; absent when the process wrote none) */
	tests?: TestVerdict[];
	/** the device the spec's last failed attempt ran on */
	device?: { udid: string; name: string };
	/** the spec process output of that attempt */
	log?: string;
	/**
	 * The device at the spec's last failure (png), when one could be captured: the spec runner's
	 * `failure.png` of the failed test when it took one, else the device as the attempt left it.
	 */
	screenshot?: string;
};

/** How the batch jobs map back to specs: the legs that ran, and in a `single` run the shard job each spec is in. */
export type RunShape = { legs: ReadonlyArray<string | undefined>; shardOf?: ReadonlyMap<string, string> };

export const ONE_LEG: RunShape = { legs: [undefined] };

export type VerdictIO = {
	readFile: (path: string) => Promise<string>;
	/** `CI` is set: a `test.only` left in a spec fails the run */
	ci: boolean;
	real?: (path: string) => string;
	/**
	 * The spec ids each attempt (`attemptKey`) of a shard job ran, when a retry ran fewer specs than
	 * the first attempt did. An attempt not listed ran every spec of its job.
	 */
	attempts?: ReadonlyMap<string, ReadonlySet<string>>;
};

export type Verdicts = {
	ok: boolean;
	specs: SpecVerdict[];
	/** jobs whose verdict fell back to the exit code (no usable `results.jsonl`) */
	warnings: string[];
	/** spec files with a `test.only`, when `ci` */
	only: string[];
};

/**
 * device / log / screenshot of a spec's failed attempts (the last one's device and log; the latest
 * screenshot there is, per attempt the runner's own `failure.png` of this spec before the batch shot).
 */
function lastFailure(
	session: SessionResult,
	failed: readonly JobResult[],
	runnerShots: ReadonlyMap<JobResult, string> = new Map()
): Partial<SpecVerdict> {
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

export const PERF_ARTIFACT_DIR = "perf";
const PERF_REPORT_FILE = `${PERF_ARTIFACT_DIR}/report.json`;

const testVerdict = (t: TestResult): TestVerdict => ({
	title: t.title,
	status: t.status,
	durationMs: t.durationMs,
	...(t.error ? { error: t.error.message } : {}),
	...(t.error?.code === "PERF_BUDGET" ? { kind: "perf_budget" as const } : {}),
	...(t.artifacts ? { artifacts: t.artifacts.dir } : {}),
	...(t.artifacts?.files.includes(PERF_REPORT_FILE) ? { perf: join(t.artifacts.dir, PERF_ARTIFACT_DIR) } : {}),
});

/** Reads and parses each `results.jsonl` once (several specs of a shard share one). */
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
	/** the runner's `failure.png` of this spec's failed test in the attempt */
	shot?: string;
};

/** Without any usable result the exit code decides every spec. */
function exitCodeVerdicts(jobSpecs: readonly SelectedSpec[], exitCode: number): Map<string, Judged> {
	const judged = new Map<string, Judged>();
	for (const spec of jobSpecs) judged.set(spec.id, { verdict: exitCode === 0 ? "passed" : "failed", fellBack: true });
	return judged;
}

/**
 * Each spec's verdict from one attempt of its job (a spec process over `jobSpecs`: one spec, or a
 * device's shard). A failed or timed-out test fails its spec. Without any usable result the exit
 * code decides every spec. After that, a non-zero exit means:
 * - a spec with no result of its own failed when the process never got to it (it sits after the last
 *   result) or when no failed test explains the exit; a skipped spec before the last result, with a
 *   failed test elsewhere accounting for the exit, is not blamed;
 * - if the process stopped before every spec had a result (a crash, a kill, a timeout), the spec
 *   whose result came last was running when it died, so it fails, and the specs before it passed;
 * - if every spec has a result, a failed test elsewhere is to blame and the specs whose tests passed
 *   pass; with no failed test anywhere the process itself failed and so does every spec.
 */
export function judgeJob(
	jobSpecs: readonly SelectedSpec[],
	all: readonly TestResult[] | undefined,
	exitCode: number,
	real: (path: string) => string
): Map<string, Judged> {
	const judged = new Map<string, Judged>();
	if (all === undefined || all.length === 0) return exitCodeVerdicts(jobSpecs, exitCode);
	const tracked = jobSpecs.map((f) => ({ id: f.id, path: f.file }));
	const bySpec = resultsBySpec(all, tracked, real);
	const lastResult = all.at(-1);
	const lastSpec = lastResult ? specOf(lastResult, tracked, real)?.id : undefined;
	const lastIndex = lastSpec === undefined ? -1 : jobSpecs.findIndex((f) => f.id === lastSpec);
	const unreached = new Set(jobSpecs.filter((f, i) => i > lastIndex && !bySpec.has(f.id)).map((f) => f.id));
	const blame: Blame = {
		exitCode,
		lastSpec,
		blamed: all.some(failing),
		stoppedEarly: jobSpecs.some((f) => !bySpec.has(f.id)),
		unreached,
	};
	for (const spec of jobSpecs) {
		const mine = bySpec.get(spec.id) ?? [];
		const failed = specFailed(spec.id, mine, blame);
		const shot = failed ? runnerFailureShot(mine) : undefined;
		judged.set(spec.id, {
			verdict: failed ? "failed" : "passed",
			tests: mine.map(testVerdict),
			fellBack: false,
			...(shot !== undefined ? { shot } : {}),
		});
	}
	return judged;
}

/** Facts about a whole job's results that decide which of its specs a non-zero exit is blamed on. */
type Blame = {
	exitCode: number;
	/** the spec whose result came last */
	lastSpec: string | undefined;
	/** some test failed somewhere in the job */
	blamed: boolean;
	/** some spec has no result at all */
	stoppedEarly: boolean;
	/** specs after the last result with no result: the process never got to them (a spec before it with none was skipped) */
	unreached: ReadonlySet<string>;
};

/** Each result under the spec it belongs to (results of no tracked spec are dropped). */
function resultsBySpec(
	all: readonly TestResult[],
	tracked: Parameters<typeof specOf>[1],
	real: (path: string) => string
): Map<string, TestResult[]> {
	const bySpec = new Map<string, TestResult[]>();
	for (const r of all) {
		const owner = specOf(r, tracked, real);
		if (owner) bySpec.set(owner.id, [...(bySpec.get(owner.id) ?? []), r]);
	}
	return bySpec;
}

/** Whether one spec fails: a failing test of its own, or a non-zero exit blamed on it. */
function specFailed(id: string, mine: readonly TestResult[], blame: Blame): boolean {
	if (mine.some(failing)) return true;
	if (blame.exitCode === 0) return false;
	if (mine.length === 0) return !blame.blamed || blame.unreached.has(id);
	if (blame.blamed) return blame.unreached.size > 0 && id === blame.lastSpec;
	return blame.stoppedEarly ? id === blame.lastSpec : true;
}

type Run = {
	session: SessionResult;
	shape: RunShape;
	real: (path: string) => string;
	load: (path: string) => Promise<TestResult[] | undefined>;
	attempts: ReadonlyMap<string, ReadonlySet<string>>;
	/** the specs of each job, by qualified job name */
	jobSpecs: ReadonlyMap<string, readonly SelectedSpec[]>;
	judgements: Map<string, Promise<Map<string, Judged>>>;
	warnings: Set<string>;
	onlyFiles: Set<string>;
};

/** One attempt of `job` judged for every spec it ran (once per attempt). */
function judgeAttempt(run: Run, job: string, attempt: JobResult): Promise<Map<string, Judged>> {
	const key = attemptKey(attempt);
	const known = run.judgements.get(key);
	if (known) return known;
	const ranIds = run.attempts.get(key);
	const specs = (run.jobSpecs.get(job) ?? []).filter((f) => ranIds === undefined || ranIds.has(f.id));
	const path = run.session.resultFiles?.get(key);
	const judged = (path === undefined ? Promise.resolve(undefined) : run.load(path)).then((all) => {
		for (const r of all ?? []) if (r.only) run.onlyFiles.add(r.file);
		const out = judgeJob(specs, all, attempt.exitCode, run.real);
		if ([...out.values()].some((j) => j.fellBack))
			run.warnings.add(`${job}: no results.jsonl — verdict from exit code ${attempt.exitCode}`);
		return out;
	});
	run.judgements.set(key, judged);
	return judged;
}

/** The attempts that failed `spec` (a non-zero exit it did not pass), with the runner's own failure shot of each. */
async function failedAttempts(run: Run, job: string, spec: SelectedSpec, ran: readonly JobResult[]) {
	const failedRuns: JobResult[] = [];
	const runnerShots = new Map<JobResult, string>();
	for (const r of ran) {
		if (r.exitCode === 0) continue;
		const mine = (await judgeAttempt(run, job, r)).get(spec.id);
		if (mine?.verdict === "passed") continue;
		failedRuns.push(r);
		if (mine?.shot !== undefined) runnerShots.set(r, mine.shot);
	}
	return { failedRuns, runnerShots };
}

/** One spec on one leg: the attempts of its job that ran it, then the verdict of the last of them. */
async function specVerdict(run: Run, spec: SelectedSpec, leg: string | undefined): Promise<SpecVerdict> {
	const { session, shape } = run;
	const job = legJob(shape.shardOf?.get(spec.id) ?? spec.id, shape.legs.length > 1 ? leg : undefined);
	const ran = (session.summary?.results ?? [])
		.filter((r) => r.job === job)
		.filter((r) => run.attempts.get(attemptKey(r))?.has(spec.id) ?? true);
	const last = ran.at(-1);
	const base = { ...spec, ...(leg !== undefined ? { leg } : {}), attempts: ran.length };
	if (!last) return { ...base, verdict: "not-run" };
	const judged = (await judgeAttempt(run, job, last)).get(spec.id);
	const { failedRuns, runnerShots } = await failedAttempts(run, job, spec, ran);
	return {
		...base,
		verdict: judged?.verdict ?? "failed",
		...(judged?.tests && !judged.fellBack ? { tests: judged.tests } : {}),
		...lastFailure(session, failedRuns, runnerShots),
	};
}

/**
 * Batch outcome → per-spec verdicts (one per leg that ran) from every job's `results.jsonl`; `ok` =
 * every required spec passed on every leg and, under CI, no spec left a `test.only`. A job without
 * a usable results file falls back to its exit code (and is listed in `warnings`).
 */
export async function verdicts(
	specs: readonly SelectedSpec[],
	session: SessionResult,
	shape: RunShape,
	io: VerdictIO
): Promise<Verdicts> {
	const jobSpecs = new Map<string, SelectedSpec[]>();
	for (const leg of shape.legs) {
		for (const spec of specs) {
			const job = legJob(shape.shardOf?.get(spec.id) ?? spec.id, shape.legs.length > 1 ? leg : undefined);
			jobSpecs.set(job, [...(jobSpecs.get(job) ?? []), spec]);
		}
	}
	const run: Run = {
		session,
		shape,
		real: io.real ?? realPath,
		load: resultsLoader(io),
		attempts: io.attempts ?? new Map(),
		jobSpecs,
		judgements: new Map(),
		warnings: new Set(),
		onlyFiles: new Set(),
	};
	const out: SpecVerdict[] = [];
	for (const leg of shape.legs) for (const spec of specs) out.push(await specVerdict(run, spec, leg));
	const only = io.ci ? [...run.onlyFiles] : [];
	const ok =
		session.summary !== undefined && only.length === 0 && out.every((f) => !f.required || f.verdict === "passed");
	return { ok, specs: out, warnings: [...run.warnings], only };
}

/** Exit-code-only gate (no files read): every required spec's job passed. Decides whether the sims are shut down. */
export function exitGate(specs: readonly SelectedSpec[], summary: BatchSummary, shape: RunShape): boolean {
	const failed = new Set(summary.failed);
	const qualified = shape.legs.length > 1;
	return specs.every(
		(spec) =>
			!spec.required ||
			shape.legs.every((leg) => {
				const job = legJob(shape.shardOf?.get(spec.id) ?? spec.id, qualified ? leg : undefined);
				return summary.results.some((r) => r.job === job) && !failed.has(job);
			})
	);
}
