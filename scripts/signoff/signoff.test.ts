import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CheckOutcome,
	commandLabel,
	describeRunner,
	describeTiming,
	GH_SIGNOFF_SUBCOMMANDS,
	parseTurboSummary,
	renderReport,
	signoffArgv,
	turboTaskName,
	umbrellaEarned,
} from "./signoff";
import {
	ALWAYS_CONTEXTS,
	applyFilters,
	planChecks,
	REQUIRED_CONTEXTS,
	SIGNOFF_CHECKS,
	UMBRELLA_CONTEXT,
} from "./signoff-checks";

const ROOT = join(import.meta.dir, "../..");

/** The contexts a diff would actually run, for terse assertions. */
function applicable(changed: string[]): string[] {
	return planChecks(changed)
		.filter((entry) => entry.applicable)
		.map((entry) => entry.check.context);
}

describe("planChecks", () => {
	test("a docs-only diff runs the always-on checks and nothing else", () => {
		expect(applicable(["AGENTS.md", "packages/e2e/native/AGENTS.md"])).toEqual([...ALWAYS_CONTEXTS]);
	});

	test("every always-on check is applicable even with an empty diff", () => {
		expect(applicable([])).toEqual([...ALWAYS_CONTEXTS]);
	});

	test("typecheck, check and test are the always-on checks", () => {
		expect([...ALWAYS_CONTEXTS]).toEqual(["typecheck", "check", "test"]);
	});

	test("a warden-simd change runs the native check", () => {
		expect(applicable(["packages/e2e/native/ios/Sources/WardenSimd/main.swift"])).toContain("native");
	});

	test("a TypeScript change outside native/ does not run the native check", () => {
		const plan = planChecks(["packages/e2e/src/driver.ts", "apps/cli/src/cli.ts"]);
		expect(plan.find((entry) => entry.check.context === "native")?.applicable).toBe(false);
	});

	test("unrelated source runs only the always-on checks", () => {
		expect(applicable(["apps/cli/src/cli.ts", "packages/core/src/store.ts"])).toEqual([...ALWAYS_CONTEXTS]);
	});

	test("a markdown file alongside real source does not mask the real source", () => {
		expect(applicable(["packages/e2e/native/AGENTS.md", "packages/e2e/native/ios/Package.swift"])).toContain("native");
	});

	test("skipped entries carry a reason naming the paths that did not match", () => {
		const native = planChecks(["apps/cli/src/cli.ts"]).find((entry) => entry.check.context === "native");
		expect(native?.applicable).toBe(false);
		expect(native?.reason).toContain("packages/e2e/native/**");
		expect(native?.filtered).toBe(false);
	});
});

describe("cpu-guard check", () => {
	test("runs for packages/e2e and agent-ui changes only", () => {
		expect(applicable(["packages/e2e/src/driver.ts"])).toContain("cpu-guard");
		expect(applicable(["apps/cli/src/agent-ui/act.ts"])).toContain("cpu-guard");
		expect(applicable(["apps/cli/src/cli.ts"])).not.toContain("cpu-guard");
		expect(applicable(["packages/e2e-bench/src/cli.ts"])).not.toContain("cpu-guard");
	});

	test("a markdown-only change under packages/e2e does not run it", () => {
		expect(applicable(["packages/e2e/AGENTS.md"])).not.toContain("cpu-guard");
	});

	test("is path-gated, never required and not mirrored in ci.yml", async () => {
		const check = SIGNOFF_CHECKS.find((c) => c.context === "cpu-guard");
		expect(check?.always).toBe(false);
		expect(check?.mirroredInCi).toBe(false);
		expect(REQUIRED_CONTEXTS).not.toContain(`${UMBRELLA_CONTEXT}/cpu-guard`);
		expect(JSON.stringify(await ciWorkflow())).not.toContain("cpu-guard");
	});

	const guardArgv = SIGNOFF_CHECKS.find((c) => c.context === "cpu-guard")?.run[0]?.argv ?? [];

	async function runGuard(env: Record<string, string>): Promise<{ code: number; out: string }> {
		const child = Bun.spawn([...guardArgv], {
			cwd: ROOT,
			env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { code, out: out + err };
	}

	/** A baseline-shaped file standing in for a run dir (the guard accepts either side). */
	function candidate(cpu: number): string {
		const dir = mkdtempSync(join(tmpdir(), "cpu-guard-"));
		const file = join(dir, "candidate.json");
		const frameworks = [{ framework: "warden", cpuSecondsPerRep: cpu, rssPeakBytes: 170_000_000 }];
		writeFileSync(
			file,
			JSON.stringify({ baselineVersion: 1, id: "cand", startedAt: "2026-10-26T00:00:00Z", platform: "ios", frameworks })
		);
		return file;
	}

	test("passes with a skip line when the run dir is unset or absent", async () => {
		const envs: Record<string, string>[] = [
			{},
			{ WARDEN_BENCH_RUN_DIR: "" },
			{ WARDEN_BENCH_RUN_DIR: "/nonexistent/bench-run" },
		];
		for (const env of envs) {
			const result = await runGuard(env);
			expect(result.code).toBe(0);
			expect(result.out).toContain("skipped: no run dir");
		}
	});

	test("compares the run dir with the baseline when it exists", async () => {
		const ok = await runGuard({ WARDEN_BENCH_RUN_DIR: candidate(3.0) });
		expect(ok.code).toBe(0);
		expect(ok.out).toContain("ok: warden cpu-s/rep 2.97 → 3.00");
		const slow = await runGuard({ WARDEN_BENCH_RUN_DIR: candidate(12) });
		expect(slow.code).toBe(1);
		expect(slow.out).toContain("regression: warden cpu-s/rep 2.97 → 12.00 (+304.0 %) exceeds 10 %");
	});
});

describe("applyFilters", () => {
	test("--only excludes every other check and marks the exclusion as a filter", () => {
		const plan = applyFilters(planChecks([]), { only: ["typecheck"], skip: [] });
		const test_ = plan.find((entry) => entry.check.context === "test");
		expect(test_).toMatchObject({ applicable: false, filtered: true, reason: "excluded by --only" });
		expect(plan.find((entry) => entry.check.context === "typecheck")?.applicable).toBe(true);
	});

	test("--skip excludes the named check and marks the exclusion as a filter", () => {
		const plan = applyFilters(planChecks([]), { only: [], skip: ["test"] });
		expect(plan.find((entry) => entry.check.context === "test")).toMatchObject({
			applicable: false,
			filtered: true,
			reason: "excluded by --skip",
		});
	});

	test("a check the diff never needed stays an ordinary skip, not a filtered one", () => {
		const plan = applyFilters(planChecks(["apps/cli/src/cli.ts"]), { only: [], skip: ["native"] });
		expect(plan.find((entry) => entry.check.context === "native")?.filtered).toBe(false);
	});
});

describe("required contexts", () => {
	test("only the umbrella is required — the always-on sub-contexts are informational", () => {
		expect([...REQUIRED_CONTEXTS]).toEqual([UMBRELLA_CONTEXT]);
	});

	test("no path-gated check is in the required list — one that never arrives deadlocks the PR", () => {
		for (const check of SIGNOFF_CHECKS) {
			if (check.always) continue;
			expect(REQUIRED_CONTEXTS).not.toContain(`${UMBRELLA_CONTEXT}/${check.context}`);
		}
	});
});

describe("umbrellaEarned", () => {
	const passed: CheckOutcome = { context: "typecheck", label: "typecheck", status: "passed", durationMs: 1 };
	const failed: CheckOutcome = { context: "test", label: "test", status: "failed", durationMs: 1 };
	const skipped: CheckOutcome = {
		context: "native",
		label: "native",
		status: "skipped",
		reason: "no files matched",
		filtered: false,
	};
	const filtered: CheckOutcome = {
		context: "test",
		label: "test",
		status: "skipped",
		reason: "excluded by --skip",
		filtered: true,
	};

	test("granted when every check that ran passed", () => {
		expect(umbrellaEarned([passed, skipped])).toBe(true);
	});

	test("withheld when any applicable check failed", () => {
		expect(umbrellaEarned([passed, failed, skipped])).toBe(false);
	});

	test("withheld when nothing ran at all", () => {
		expect(umbrellaEarned([skipped])).toBe(false);
	});

	test("withheld when --only/--skip dropped a check the diff needed", () => {
		// Only the umbrella is required, so a filtered run that still wrote it would make
		// `--skip test` a way to merge without tests.
		expect(umbrellaEarned([passed, filtered])).toBe(false);
	});
});

describe("signoffArgv", () => {
	const SHA = "fef9cfbec6816aa17c09971c704696818782e921";

	test("names `create` explicitly so no context can be read as a subcommand", () => {
		// `check` is BOTH a context and a gh-signoff subcommand: `gh signoff check --commit <sha>` is
		// parsed as the subcommand and writes nothing.
		expect(signoffArgv(SHA, "check")).toEqual(["gh", "signoff", "create", "check", "--commit", SHA]);
	});

	test("every check this repo defines survives the collision", () => {
		for (const check of SIGNOFF_CHECKS) {
			const argv = signoffArgv(SHA, check.context);
			expect(argv[2]).toBe("create");
			expect(argv[3]).toBe(check.context);
		}
	});

	test("the umbrella is written with no context at all", () => {
		expect(signoffArgv(SHA, null)).toEqual(["gh", "signoff", "create", "--commit", SHA]);
	});

	test("a context colliding with any subcommand is still passed as a context", () => {
		for (const subcommand of GH_SIGNOFF_SUBCOMMANDS) {
			expect(signoffArgv(SHA, subcommand)).toEqual(["gh", "signoff", "create", subcommand, "--commit", SHA]);
		}
	});
});

describe("describeRunner", () => {
	test("names Claude Code when an agent signs off", () => {
		expect(describeRunner({ CLAUDECODE: "1" })).toBe("Claude Code");
		expect(describeRunner({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe("Claude Code");
	});

	test("reports a plain shell as human", () => {
		expect(describeRunner({})).toContain("human");
	});

	test("a dispatched workflow reports itself, not a human", () => {
		expect(describeRunner({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW: "ci" })).toBe("GitHub Actions (ci)");
	});
});

describe("renderReport", () => {
	const report = renderReport({
		sha: "4c75ae3f1d2b",
		actor: "UrbanChrisy",
		runner: "Claude Code",
		when: "2026-10-21 09:00 UTC",
		outcomes: [
			{ context: "typecheck", label: "typecheck", status: "passed", durationMs: 12_000 },
			{ context: "test", label: "test", status: "passed", durationMs: 221_000, note: "a qualifying note" },
			{
				context: "native",
				label: "native (warden-simd)",
				status: "skipped",
				reason: "no files matched packages/e2e/native/**",
				filtered: false,
			},
		],
	});

	test("carries the marker so a re-run updates in place instead of stacking comments", () => {
		expect(report.startsWith("<!-- signoff-report -->")).toBe(true);
	});

	test("names who signed off and what ran it", () => {
		expect(report).toContain("@UrbanChrisy");
		expect(report).toContain("Claude Code");
	});

	test("pins the SHA the statuses are bound to", () => {
		expect(report).toContain("4c75ae3");
	});

	test("shows durations, notes and the reason a check was skipped", () => {
		expect(report).toContain("12s");
		expect(report).toContain("3m 41s");
		expect(report).toContain("a qualifying note");
		expect(report).toContain("no files matched packages/e2e/native/**");
	});

	test("a withheld umbrella is stated, not implied by an absent row", () => {
		const failing = renderReport({
			sha: "deadbee",
			actor: "UrbanChrisy",
			runner: "human (interactive shell)",
			when: "now",
			outcomes: [{ context: "test", label: "test", status: "failed", durationMs: 1000 }],
		});
		expect(failing).toContain("not signed off");
	});

	test("a filtered run is reported as partial, not as signed off", () => {
		const partial = renderReport({
			sha: "deadbee",
			actor: "UrbanChrisy",
			runner: "human (interactive shell)",
			when: "now",
			outcomes: [
				{ context: "typecheck", label: "typecheck", status: "passed", durationMs: 1000 },
				{ context: "test", label: "test", status: "skipped", reason: "excluded by --skip", filtered: true },
			],
		});
		expect(partial).toContain("not signed off");
		expect(partial).toContain("excluded by --skip");
	});

	test("the detail column names the slowest turbo task, not just the check total", () => {
		const slow = renderReport({
			sha: "4c75ae3f1d2b",
			actor: "UrbanChrisy",
			runner: "human (interactive shell)",
			when: "now",
			outcomes: [
				{
					context: "test",
					label: "test",
					status: "passed",
					durationMs: 310_733,
					timings: [
						{
							label: "bunx turbo test",
							durationMs: 310_733,
							tasks: [
								{ taskId: "@delacour/warden-core#test", durationMs: 310_587, cached: false },
								{ taskId: "@delacour/warden#test", durationMs: 6570, cached: false },
							],
						},
					],
				},
			],
		});
		expect(slow).toContain("@delacour/warden-core#test");
		expect(slow).toContain("5m 11s");
	});
});

/** A payload shaped like what `turbo --summarize` writes to `.turbo/runs/<id>.json`. */
function summaryFixture(
	tasks: readonly { taskId: string; startTime: number; endTime: number; status?: string }[]
): unknown {
	return {
		execution: { command: "turbo run test", startTime: 0, endTime: 1, exitCode: 0 },
		tasks: tasks.map((task) => ({
			taskId: task.taskId,
			cache: { status: task.status ?? "MISS" },
			execution: { startTime: task.startTime, endTime: task.endTime, exitCode: 0 },
		})),
	};
}

describe("parseTurboSummary", () => {
	test("returns every task slowest first, in wall-clock milliseconds", () => {
		const tasks = parseTurboSummary(
			summaryFixture([
				{ taskId: "a#test", startTime: 1000, endTime: 1415 },
				{ taskId: "b#test", startTime: 1000, endTime: 311_587 },
			])
		);
		expect(tasks?.map((task) => task.taskId)).toEqual(["b#test", "a#test"]);
		expect(tasks?.[0]?.durationMs).toBe(310_587);
	});

	test("a cache HIT reads as cached, so a replay cannot pass for fast work", () => {
		const tasks = parseTurboSummary(summaryFixture([{ taskId: "a#check", startTime: 1, endTime: 1, status: "HIT" }]));
		expect(tasks?.[0]?.cached).toBe(true);
	});

	test("an unrecognisable payload yields null rather than a wrong answer", () => {
		expect(parseTurboSummary(null)).toBeNull();
		expect(parseTurboSummary({})).toBeNull();
		expect(parseTurboSummary({ tasks: "nope" })).toBeNull();
	});

	test("a task missing its execution block is dropped, never guessed at", () => {
		const tasks = parseTurboSummary({
			tasks: [{ taskId: "a#test" }, { taskId: "b#test", execution: { startTime: 0, endTime: 5 } }],
		});
		expect(tasks).toEqual([{ taskId: "b#test", durationMs: 5, cached: false }]);
	});
});

describe("turboTaskName", () => {
	test("names the task every always-on check runs, so --summarize can be added to it", () => {
		for (const context of ALWAYS_CONTEXTS) {
			const check = SIGNOFF_CHECKS.find((entry) => entry.context === context);
			for (const command of check?.run ?? []) expect(turboTaskName(command.argv)).toBe(context);
		}
	});

	test("skips an explicit `run` verb", () => {
		expect(turboTaskName(["bunx", "turbo", "run", "test"])).toBe("test");
	});

	test("a non-turbo command has no task", () => {
		expect(turboTaskName(["swift", "test", "--package-path", "packages/e2e/native/ios"])).toBeNull();
		expect(turboTaskName(["bun", "run", "--cwd", "packages/e2e", "native:build"])).toBeNull();
	});

	test("a turbo invocation carrying only flags names no task", () => {
		expect(turboTaskName(["bunx", "turbo", "--version"])).toBeNull();
	});
});

describe("describeTiming", () => {
	test("a fully replayed run says so — a cache hit is not evidence the work ran", () => {
		const detail = describeTiming([
			{ label: "bunx turbo check", durationMs: 900, tasks: [{ taskId: "a#check", durationMs: 0, cached: true }] },
		]);
		expect(detail).toContain("replayed from cache");
	});

	test("a multi-command check breaks down per command", () => {
		const detail = describeTiming([
			{ label: "bun run --cwd packages/e2e native:build", durationMs: 110_000, tasks: [] },
			{ label: "swift test", durationMs: 18_000, tasks: [] },
		]);
		expect(detail).toContain("1m 50s");
		expect(detail).toContain("18s");
	});

	test("one command with no tasks adds nothing", () => {
		expect(describeTiming([{ label: "swift test", durationMs: 90_000, tasks: [] }])).toBeUndefined();
	});
});

describe("commandLabel", () => {
	test("truncates a long one rather than wrapping the report table", () => {
		const label = commandLabel(["bunx", "turbo", "test", "--concurrency=6", "--continue=dependencies-successful"]);
		expect(label.length).toBeLessThanOrEqual(48);
		expect(label.endsWith("…")).toBe(true);
	});

	test("escapes a pipe, which would otherwise split the markdown table cell", () => {
		expect(commandLabel(["sh", "-c", "a|b"])).toBe("sh -c a\\|b");
	});
});

type Workflow = {
	on: Record<string, { inputs?: Record<string, unknown> } | null>;
	jobs: Record<string, { steps?: { run?: string }[] }>;
};

async function ciWorkflow(): Promise<Workflow> {
	return Bun.YAML.parse(await Bun.file(join(ROOT, ".github/workflows/ci.yml")).text()) as Workflow;
}

describe("drift guard", () => {
	test("every check points at a workflow file that exists", () => {
		for (const check of SIGNOFF_CHECKS) {
			expect(existsSync(join(ROOT, ".github/workflows", check.workflow))).toBe(true);
		}
	});

	test("ci.yml is workflow_dispatch only — no billed run on a pull request or a push", async () => {
		const workflow = await ciWorkflow();
		expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
		expect(workflow.on.workflow_dispatch?.inputs).toHaveProperty("signoff-sha");
	});

	test("the dispatched run writes every check's context and the umbrella", async () => {
		// The escape hatch has to earn the same statuses a local run would, or it cannot unblock a PR.
		const scripts = Object.values((await ciWorkflow()).jobs)
			.flatMap((job) => job.steps ?? [])
			.map((step) => step.run ?? "")
			.join("\n");
		for (const check of SIGNOFF_CHECKS.filter((c) => c.mirroredInCi !== false)) {
			expect(scripts).toContain(`post ${UMBRELLA_CONTEXT}/${check.context}`);
		}
		expect(scripts).toMatch(new RegExp(`^post ${UMBRELLA_CONTEXT}$`, "m"));
	});

	test("no check declares an empty command", () => {
		for (const check of SIGNOFF_CHECKS) {
			expect(check.run.length).toBeGreaterThan(0);
			for (const command of check.run) expect(command.argv.length).toBeGreaterThan(0);
		}
	});

	test("contexts are unique", () => {
		const contexts = SIGNOFF_CHECKS.map((check) => check.context);
		expect(new Set(contexts).size).toBe(contexts.length);
	});
});
