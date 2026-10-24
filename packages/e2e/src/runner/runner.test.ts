import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readResults, type TestResult } from "./results";
import { readTrace } from "./trace";

/**
 * bun's `test` cannot be registered inside a running test, so every case runs a fixture spec in a
 * child `bun test` with the fake driver preload and reads back what the wrapper produced.
 */

const FIXTURES = join(import.meta.dir, "fixtures");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Run = {
	exitCode: number;
	stdout: string;
	stderr: string;
	results: TestResult[];
	log: string[];
	out: string;
	spec: string;
};

async function runSpec(names: string | string[], env: Record<string, string> = {}): Promise<Run> {
	const dir = mkdtempSync(join(tmpdir(), "wdn-runner-"));
	dirs.push(dir);
	const specs = [names].flat().map((name) => join(FIXTURES, `${name}.e2e.ts`));
	const spec = specs[0] ?? "";
	const out = join(dir, "out");
	const logPath = join(dir, "fixture.log");
	const childEnv: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		WARDEN_UDID: "FAKE-UDID-0123456789",
		WARDEN_BUNDLE_ID: "com.acme.app",
		WARDEN_E2E_OUT: out,
		WARDEN_E2E_FLOWS_DIR: FIXTURES,
		WARDEN_LOG_TIMESTAMPS: "1",
		FIXTURE_LOG: logPath,
		...env,
	};
	const proc = Bun.spawn([process.execPath, "test", "--preload", join(FIXTURES, "preload.ts"), ...specs], {
		cwd: dir,
		env: childEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const resultsPath = join(out, "results.jsonl");
	return {
		exitCode,
		stdout,
		stderr,
		results: existsSync(resultsPath) ? readResults(readFileSync(resultsPath, "utf8")) : [],
		log: existsSync(logPath) ? readFileSync(logPath, "utf8").trimEnd().split("\n") : [],
		out,
		spec,
	};
}

const byTitle = (run: Run, title: string): TestResult => {
	const found = run.results.find((r) => r.title.at(-1) === title);
	if (!found) throw new Error(`no result for "${title}" in ${JSON.stringify(run.results.map((r) => r.title))}`);
	return found;
};

describe("hooks", () => {
	test("run outermost-first before and innermost-first after, around the body", async () => {
		const run = await runSpec("hooks");
		expect(run.exitCode).toBe(0);
		expect(run.log).toEqual([
			"beforeAll root",
			"beforeAll outer",
			"beforeEach root",
			"beforeEach outer",
			"beforeEach inner",
			"body ios",
			"afterEach inner",
			"afterEach outer",
			"afterEach root",
			"afterAll outer",
			"afterAll root",
		]);
		expect(run.results.map((r) => [r.title, r.status])).toEqual([[["outer", "inner", "runs in order"], "passed"]]);
		expect(run.results[0]?.file).toBe(run.spec);
		expect(run.results[0]?.device).toEqual({ udid: "FAKE-UDID-0123456789", platform: "ios" });
	});
});

describe("extend", () => {
	test("teardown runs after a failure, in reverse order, and the next test gets fresh fixtures", async () => {
		const run = await runSpec("extend");
		expect(run.exitCode).toBe(1);
		expect(run.log).toEqual([
			"account setup",
			"session setup for acct-1",
			"body acct-1 acct-1 ios",
			"afterEach",
			"session teardown",
			"account teardown",
			"account setup",
			"session setup for acct-1",
			"second acct-1",
			"afterEach",
			"session teardown",
			"account teardown",
		]);
		expect(byTitle(run, "uses fixtures and fails")).toMatchObject({ status: "failed", error: { message: "boom" } });
		expect(byTitle(run, "fixtures are set up again for the next test").status).toBe("passed");
	});
});

describe("failures", () => {
	test("a throwing body still writes its results line, with error code and artifacts", async () => {
		const run = await runSpec("throws");
		expect(run.exitCode).toBe(1);
		const typed = byTitle(run, "throws an E2eError");
		expect(typed).toMatchObject({ status: "failed", error: { message: "expected visible", code: "ASSERTION" } });
		expect(byTitle(run, "throws a plain error synchronously")).toMatchObject({
			status: "failed",
			error: { message: "plain" },
		});
		const artifacts = typed.artifacts;
		expect(artifacts?.files).toEqual(["failure.png", "screen-at-failure.txt", "trace.jsonl"].sort());
		const dir = artifacts?.dir ?? "";
		expect(dir.startsWith(join(run.out, "throws", "throws-an-e2eerror-"))).toBe(true);
		expect(readFileSync(join(dir, "failure.png"), "utf8")).toBe("PNG");
		const screen = readFileSync(join(dir, "screen-at-failure.txt"), "utf8");
		expect(screen).toContain("# ios axbridge");
		expect(screen).toContain('[button] "Sign in" id=sign-in');
	});
});

describe("deadline", () => {
	test("a never-answering step and a never-settling body time out; the next test starts clean", async () => {
		const run = await runSpec("timeout");
		expect(run.exitCode).toBe(1);
		const step = byTitle(run, "a driver call that never answers");
		expect(step).toMatchObject({ status: "timed-out", error: { code: "TIMEOUT" } });
		expect(step.durationMs).toBeLessThan(5000);
		expect(byTitle(run, "a body that never settles")).toMatchObject({
			status: "timed-out",
			error: { code: "TIMEOUT" },
		});
		expect(byTitle(run, "the next test starts clean").status).toBe("passed");
		expect(run.log).toEqual(["next depth=0 aborted=false"]);

		const dir = step.artifacts?.dir ?? "";
		const trace = readTrace(readFileSync(join(dir, "trace.jsonl"), "utf8")).filter((e) => e.type !== "span");
		expect(trace.map((e) => [e.type, e.label])).toEqual([
			["step-start", "app.open"],
			["step-end", "app.open"],
			["step-start", "tap id=sign-in"],
			["step-end", "tap id=sign-in"],
		]);
		expect(trace[3]).toMatchObject({ status: "failed", error: expect.stringContaining("timed out after 300ms") });
	});
});

describe("zombies", () => {
	test("a body or afterEach the runner gave up on cannot drive the device during the next test", async () => {
		const run = await runSpec("zombie");
		expect(byTitle(run, "sleeps past its deadline then taps")).toMatchObject({ status: "timed-out" });
		expect(byTitle(run, "its afterEach outlives the cleanup limit")).toMatchObject({
			status: "failed",
			error: { code: "TIMEOUT" },
		});
		expect(byTitle(run, "runs while the zombie body taps").status).toBe("passed");
		expect(byTitle(run, "runs while the zombie afterEach taps").status).toBe("passed");
		expect(run.log).toHaveLength(4);
		expect(run.log).toContain("victim of the body done");
		expect(run.log).toContain("victim of the hook done");
		const rejected = run.log.filter((line) => /^(body|afterEach) tap rejected (TIMEOUT|SESSION)$/.test(line));
		expect(rejected.map((line) => line.split(" ")[0]).sort()).toEqual(["afterEach", "body"]);

		for (const victim of ["runs while the zombie body taps", "runs while the zombie afterEach taps"]) {
			const dir = byTitle(run, victim).artifacts?.dir;
			const path = dir === undefined ? "" : join(dir, "trace.jsonl");
			const trace = existsSync(path) ? readTrace(readFileSync(path, "utf8")) : [];
			expect(trace.filter((e) => e.type !== "span").map((e) => [e.type, e.label])).toEqual([]);
			expect(trace.filter((e) => e.type === "span").map((e) => e.op)).toEqual([]);
		}
	});
});

describe("post-deadline budget", () => {
	test("slow afterEach hooks share one budget inside bun's margin: bun never starts the next test early", async () => {
		const run = await runSpec("slow-cleanup");
		const lines = run.stdout.split("\n");
		const end = lines.findIndex((l) => l.startsWith("■") && l.includes("slow cleanup"));
		const nextStart = lines.findIndex((l) => l.startsWith("▶") && l.includes("next"));
		expect(end).toBeGreaterThanOrEqual(0);
		expect(nextStart).toBeGreaterThan(end);
		expect(run.results.map((r) => [r.title.at(-1), r.status])).toEqual([
			["slow cleanup", "timed-out"],
			["next", "passed"],
		]);
		const slow = byTitle(run, "slow cleanup");
		expect(slow.durationMs).toBeLessThan(1_600);
		expect(run.log[0]).toBe("afterEach 1 done");
		expect(run.log).toContain("next body");
		expect(run.stderr).not.toContain("this test timed out after");
	});

	test("a test.use({ timeout }) below a test in the same scope is warned about, once", async () => {
		const run = await runSpec("use-late");
		expect(run.exitCode).toBe(0);
		const warnings = run.stderr.split("\n").filter((l) => l.includes("comes after a test in the same scope"));
		expect(warnings).toEqual([expect.stringContaining("test.use({ timeout: 200000 })")]);
	});
});

describe("only", () => {
	test("is recorded in the result, and passes outside CI", async () => {
		const run = await runSpec("only");
		expect(run.exitCode).toBe(0);
		expect(byTitle(run, "focused").only).toBe(true);
		// bun itself skips the other tests once a `.only` is collected
		expect(run.results.map((r) => r.title.at(-1))).toEqual(["focused"]);
	});

	test("fails the run under CI", async () => {
		const run = await runSpec("only", { CI: "1" });
		expect(run.exitCode).not.toBe(0);
		expect(run.stderr).toContain("not allowed in CI");
	});
});

describe("retry", () => {
	test("only the final attempt writes a results line, every attempt prints", async () => {
		const run = await runSpec("retry");
		expect(run.exitCode).toBe(0);
		expect(run.results.map((r) => r.status)).toEqual(["passed"]);
		const ends = run.stdout.split("\n").filter((l) => l.startsWith("■"));
		expect(ends.map((l) => (l.includes(" failed ") ? "failed" : "passed"))).toEqual(["failed", "failed", "passed"]);
	});
});

describe("lost HID connection", () => {
	test("the sim is rebooted once and the whole test runs again; the first failure is not recorded", async () => {
		const run = await runSpec("hid");
		const udid = "FAKE-UDID-0123456789";
		expect(run.log).toEqual([
			"body run 1",
			`exec xcrun simctl shutdown ${udid}`,
			`exec xcrun simctl bootstatus ${udid} -b`,
			"body run 2",
			"body run 3",
		]);
		expect(run.stdout).toContain("HID connection lost (Device Hub quit?), rebooted");
		expect(run.stdout).toContain("lost again after a reboot; `warden release <id> --shutdown`");
		const first = run.results.filter((r) => r.title.at(-1) === "tap after Device Hub quit");
		expect(first.map((r) => r.status)).toEqual(["passed"]);
		const second = run.results.filter((r) => r.title.at(-1) === "a second loss is not recovered");
		expect(second.map((r) => r.status)).toEqual(["failed"]);
		expect(run.exitCode).toBe(1);
	});
});

describe("skip", () => {
	test("skip, skipIf, option skip, platform filter and todo never run their body", async () => {
		const run = await runSpec("skip");
		expect(run.exitCode).toBe(0);
		expect(run.log).toEqual(["skipIf false ran", "ios only ran"]);
	});
});

describe("use", () => {
	test("options resolve from the nearest scope and reach the fixture factory", async () => {
		const run = await runSpec("use", { FIXTURE_LOG_CTX: "1" });
		expect(run.exitCode).toBe(0);
		expect(run.log).toEqual(["ctx fresh action=1111 assertion=5000", "ctx none action=1111 assertion=222"]);
	});
});

describe("several files in one process", () => {
	test("test.use and root hooks of one file do not reach the next; the session survives the preload afterAll", async () => {
		const run = await runSpec(["use", "launch"], { FIXTURE_LOG_CTX: "1" });
		expect(run.exitCode).toBe(0);
		expect(run.log.filter((l) => l.startsWith("ctx "))).toEqual([
			"ctx fresh action=1111 assertion=5000",
			"ctx none action=1111 assertion=222",
			"ctx fresh action=30000 assertion=5000",
			"ctx none action=30000 assertion=5000",
		]);
		expect(run.results).toHaveLength(4);
		expect(new Set(run.results.map((r) => r.file)).size).toBe(2);
	});
});

describe("default fixtures", () => {
	test("screen taps through the real chain: fixture factory, locator, driver", async () => {
		const run = await runSpec("screen");
		expect(run.exitCode).toBe(1);
		expect(run.log).toEqual(['taps=1 at {"x":195,"y":22}', "welcome=true", "snapshot has button=true"]);

		const tapped = byTitle(run, "taps a locator through app, device and screen");
		expect(tapped.status).toBe("passed");
		const trace = readTrace(readFileSync(join(tapped.artifacts?.dir ?? "", "trace.jsonl"), "utf8"));
		expect(trace.some((e) => e.type === "step-end" && e.kind === "locator" && /tap/.test(e.label))).toBe(true);
		// trace.jsonl also holds the driver calls, device calls and locator reads as spans, flushed when the attempt ended
		const spans = trace.flatMap((e) => (e.type === "span" ? [e] : []));
		const ops = spans.map((s) => s.op);
		expect(ops).toContain("driver.snapshot");
		expect(ops).toContain("driver.tap");
		expect(ops).toContain("read.isVisible");
		expect(ops).toContain("device.snapshot");
		expect(spans.every((s) => s.ok && s.ms >= 0 && s.ts > 0)).toBe(true);

		const missing = byTitle(run, "a locator that matches nothing fails with LOCATOR_NOT_FOUND and the screen excerpt");
		expect(missing).toMatchObject({ status: "failed", error: { code: "LOCATOR_NOT_FOUND" } });
		expect(missing.error?.message).toContain("missing");
		expect(missing.artifacts?.files).toContain("screen-at-failure.txt");
	});
});

describe("soft failures", () => {
	test("fail the attempt after the body, are reported together, and reset for the next attempt", async () => {
		const run = await runSpec("soft");
		expect(run.exitCode).toBe(1);
		const many = byTitle(run, "soft failures fail the attempt after the body");
		expect(many).toMatchObject({ status: "failed", error: { code: "ASSERTION" } });
		expect(many.error?.message).toContain("2 soft assertions failed");
		expect(many.error?.message).toContain("1) first soft");
		expect(many.error?.message).toContain("2) second soft");
		expect(byTitle(run, "one soft failure is reported as is").error?.message).toBe("only soft");
		expect(byTitle(run, "the list starts empty for every attempt").status).toBe("passed");
		expect(run.log).toEqual(["body finished", "soft=0"]);
	});
});

describe("launch", () => {
	test("fresh (default) opens the app before the body with WARDEN_LAUNCH_ARGS; none leaves it to the body", async () => {
		const run = await runSpec("launch", { WARDEN_LAUNCH_ARGS: '["--initialUrl","http://x"]' });
		expect(run.exitCode).toBe(0);
		expect(run.log).toEqual([
			'default launches=1 args=["--initialUrl","http://x"]',
			'before launches=1 args=["--initialUrl","http://x"]',
			'after launches=2 args=["--initialUrl","http://x","--extra"]',
		]);
	});
});

describe("reporter", () => {
	test("prints ▶/■ per test and ▸/▪ per step in the PR #22 format", async () => {
		const run = await runSpec("report");
		const spec = run.spec;
		const lines = run.stdout
			.split("\n")
			.filter((l) => /^\s*[▶▸▪■]/.test(l))
			.map((l) =>
				l
					.replaceAll(spec, "<spec>")
					.replace(/\d+ms/g, "Nms")
					.replace(/\d+\.\d\ds/g, "N.NNs")
			);
		expect(lines).toEqual([
			"▶ test |ios| <spec> › steps",
			"  ▸ report › app app.open",
			"  ▪ report › app app.open passed Nms",
			"  ▸ report › locator tap id=sign-in",
			"    ▸ report › driver snapshot",
			"    ▪ report › driver snapshot passed Nms",
			"  ▪ report › locator tap id=sign-in passed Nms",
			"■ test |ios| <spec> › steps passed N.NNs on FAKE-UDID…",
			"▶ test |ios| <spec> › fails in a step",
			"  ▸ report › expect toBeVisible id=missing",
			"  ▪ report › expect toBeVisible id=missing failed Nms — not found",
			"■ test |ios| <spec> › fails in a step failed N.NNs on FAKE-UDID…",
		]);
	});

	test("adds its own clock unless warden already stamps the log", async () => {
		const run = await runSpec("report", { WARDEN_LOG_TIMESTAMPS: "0" });
		const first = run.stdout.split("\n").find((l) => l.includes("▶ test"));
		expect(first).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] ▶ test \|ios\|/);
	});
});
