import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The e2e composite action's job timing line (`.github/actions/e2e/job-timing.sh`), run under the macOS system
 * bash (3.2) with a stub `curl` for the GitHub jobs API. The script must never fail the job: a refused or missing
 * API answer falls back to timing the action alone.
 */
const ROOT = join(import.meta.dir, "..", "..");
const ACTION_DIR = join(ROOT, ".github", "actions", "e2e");
const SCRIPT = join(ACTION_DIR, "job-timing.sh");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
const JQ = Bun.which("jq");

/** job 1000 → action 1080 → suite 1106 → 1267: prep 1m46s (80 s before the action, 26 s in it), suite 2m41s */
const TIMES = { ACTION_STARTED: "1080", SUITE_STARTED: "1106", SUITE_ENDED: "1267" };
const JOBS = {
	jobs: [
		{ runner_name: "other", status: "in_progress", started_at: "1970-01-01T00:00:10Z" },
		{ runner_name: "GitHub Actions 7", status: "completed", started_at: "1970-01-01T00:00:20Z" },
		{ runner_name: "GitHub Actions 7", status: "in_progress", started_at: "1970-01-01T00:16:40Z" },
	],
};

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-job-timing-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A `curl` that logs its argv and answers `body` (exit `code`), first on PATH, next to jq. */
function stubCurl(body: string, code = 0): void {
	const log = join(dir, "curl.log");
	writeFileSync(join(dir, "curl"), `#!/bin/sh\necho "$@" >> '${log}'\nprintf '%s' '${body}'\nexit ${code}\n`);
	chmodSync(join(dir, "curl"), 0o755);
}

const curlCalls = (): string[] => {
	const log = join(dir, "curl.log");
	return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
};

function run(env: Record<string, string>): { code: number; out: string } {
	const proc = Bun.spawnSync([BASH, SCRIPT], {
		env: { PATH: `${dir}:${JQ ? join(JQ, "..") : ""}:/usr/bin:/bin`, ...TIMES, ...env },
	});
	return { code: proc.exitCode, out: proc.stdout.toString().trim() };
}

const API = {
	JOB_TIMING_TOKEN: "t0k",
	GITHUB_API_URL: "https://api.github.test",
	GITHUB_REPOSITORY: "acme/app",
	GITHUB_RUN_ID: "42",
	GITHUB_RUN_ATTEMPT: "2",
	RUNNER_NAME: "GitHub Actions 7",
};

describe("job-timing.sh", () => {
	test("JOB_STARTED given: prep split into the workflow's steps and the action's, then the suite and the total", () => {
		expect(run({ JOB_STARTED: "1000" })).toEqual({
			code: 0,
			out: "job timing: prep 1m46s (workflow steps 1m20s · action 26s) · warden e2e 2m41s · total 4m27s",
		});
		expect(curlCalls()).toEqual([]);
	});

	test.skipIf(!JQ)("reads this job's start from the jobs API: same runner, in progress", () => {
		stubCurl(JSON.stringify(JOBS));
		expect(run(API).out).toBe(
			"job timing: prep 1m46s (workflow steps 1m20s · action 26s) · warden e2e 2m41s · total 4m27s"
		);
		const [call] = curlCalls();
		expect(call).toContain("https://api.github.test/repos/acme/app/actions/runs/42/attempts/2/jobs");
		expect(call).toContain("Authorization: Bearer t0k");
	});

	test("a refused API answer falls back to the action alone and still exits 0", () => {
		stubCurl('{"message":"Resource not accessible by integration"}', 22);
		expect(run(API)).toEqual({
			code: 0,
			out: "job timing: action prep 26s · warden e2e 2m41s (job start unknown: the token needs actions: read)",
		});
	});

	test("no token: no API call, the same fallback", () => {
		stubCurl(JSON.stringify(JOBS));
		const { JOB_TIMING_TOKEN: _, ...noToken } = API;
		expect(run(noToken).out).toStartWith("job timing: action prep 26s · warden e2e 2m41s");
		expect(curlCalls()).toEqual([]);
	});

	test("hours, whole minutes and a clock that steps back", () => {
		expect(run({ JOB_STARTED: "0", ACTION_STARTED: "3600", SUITE_STARTED: "3720", SUITE_ENDED: "3600" }).out).toBe(
			"job timing: prep 1h2m (workflow steps 1h · action 2m) · warden e2e 0s · total 1h2m"
		);
	});

	test("no suite times (it never started): prints nothing", () => {
		expect(run({ JOB_STARTED: "1000", SUITE_STARTED: "", SUITE_ENDED: "" })).toEqual({ code: 0, out: "" });
	});
});

describe("action.yml job timing", () => {
	type Step = { id?: string; if?: string; run?: string; env?: Record<string, string> };
	type Action = { inputs: Record<string, { default?: string }>; runs: { steps: Step[] } };
	const action = Bun.YAML.parse(readFileSync(join(ACTION_DIR, "action.yml"), "utf8")) as Action;
	const steps = action.runs.steps;

	test("the first step stamps the action's start; the timing step follows the suite, always, with the token", () => {
		expect(steps[0]?.id).toBe("prepare");
		expect(steps[0]?.run).toContain('echo "started=$(date +%s)" >> "$GITHUB_OUTPUT"');
		const runIndex = steps.findIndex((s) => s.id === "run");
		const timing = steps[runIndex + 1];
		expect(timing?.if).toBe("always()");
		expect(timing?.run).toContain("job-timing.sh");
		expect(timing?.env).toEqual({
			JOB_TIMING_TOKEN: "${{ inputs.github-token }}",
			ACTION_STARTED: "${{ steps.prepare.outputs.started }}",
			SUITE_STARTED: "${{ steps.run.outputs.started }}",
			SUITE_ENDED: "${{ steps.run.outputs.ended }}",
		});
		expect(action.inputs["github-token"]?.default).toBe("${{ github.token }}");
	});

	test("the token never reaches the suite's own step", () => {
		const runStep = steps.find((s) => s.id === "run");
		expect(JSON.stringify(runStep?.env ?? {})).not.toContain("github-token");
	});
});
