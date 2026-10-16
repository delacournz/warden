import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@delacour/warden-types/result";
import { type BenchAdapter, type FrameworkId, failed, type RunContext, unsupported } from "./adapters/adapter.types";
import { type FakeRule, fakeExec } from "./harness/exec";
import {
	type BenchDeps,
	type BenchOptions,
	finalizeFrameworks,
	loadTooHigh,
	runBench,
	runStamp,
	summaryLines,
	trackingExec,
} from "./orchestrator";
import { loadManifest } from "./results/manifest";
import { benchRunSchema, CANONICAL_IDS, type RepResult } from "./results/schema";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const manifest = loadManifest(PACKAGE_ROOT);

let dir: string;
let appPath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "bench-orch-"));
	appPath = join(dir, "Example.apk");
	writeFileSync(appPath, "binary");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function rules(): FakeRule[] {
	const sysctl: Record<string, string> = {
		"hw.model": "Mac15,9",
		"machdep.cpu.brand_string": "Apple M3 Max",
		"hw.ncpu": "100000",
		"hw.memsize": "68719476736",
	};
	return [
		{ cmd: "sysctl", result: (args) => ({ stdout: `${sysctl[args[1] ?? ""] ?? ""}\n` }) },
		{ cmd: "sw_vers", result: { stdout: "15.2\n" } },
		{
			cmd: process.execPath,
			match: (a) => a[1] === "claim",
			result: { stdout: JSON.stringify({ leases: [{ leaseId: "lease-1", udid: "UDID-1", name: "iPhone 16" }] }) },
		},
		{
			cmd: process.execPath,
			match: (a) => a[1] === "app" && a[2] === "ensure",
			result: { stdout: JSON.stringify({ appPath, hash: "abc", source: "cache", installed: true }) },
		},
		{ cmd: "xcrun", match: (a) => a.includes("devices"), result: { stdout: JSON.stringify({ devices: {} }) } },
		{ cmd: process.execPath, match: (a) => a[1] === "release", result: { stdout: "" } },
		{ cmd: "du", result: { stdout: "1\tx\n" } },
	];
}

function rep(index: number): RepResult {
	return {
		index,
		cold: index === 1,
		wallMs: 1,
		wallSource: "harness",
		startedAt: "x",
		rawArtifactDir: "x",
		tests: CANONICAL_IDS.map((id) => ({ id, nativeName: id, status: "passed" as const, durationMs: 100 })),
	};
}

type Calls = string[];

function adapter(id: FrameworkId, calls: Calls, overrides: Partial<BenchAdapter> = {}): BenchAdapter {
	const phase = (name: string, ctx: RunContext) =>
		calls.push(`${id}.${name}${name === "run" ? `:${ctx.cold ? "cold" : "warm"}` : ""}`);
	return {
		id,
		supports: ["ios", "android"],
		residuePatterns: { processes: [], driverBundleIds: [], dirs: [] },
		async doctor(ctx) {
			phase("doctor", ctx);
			return { ok: true, version: "1.0.0", notes: [] };
		},
		async prepare(ctx) {
			phase("prepare", ctx);
			return ok(undefined);
		},
		async run(ctx) {
			phase("run", ctx);
			await Bun.sleep(2);
			return ok(rep(1));
		},
		async teardown(ctx) {
			phase("teardown", ctx);
			return ok(undefined);
		},
		...overrides,
	};
}

function setup(adapters: BenchAdapter[], extra: Partial<BenchOptions> = {}, signal?: AbortSignal) {
	const exec = fakeExec(rules(), { which: ["caffeinate"] });
	const logs: string[] = [];
	const results: string[] = [];
	const opts: BenchOptions = {
		platform: "ios",
		frameworks: adapters.map((a) => a.id),
		runs: 3,
		retries: 0,
		rebootBetween: false,
		skipDoctor: false,
		force: false,
		keepDrivers: false,
		out: join(dir, "out"),
		...extra,
	};
	const deps: BenchDeps = {
		exec,
		now: () => new Date("2026-10-16T12:00:00.000Z"),
		adapters,
		cliPath: "/cli.ts",
		repoRoot: dir,
		packageRoot: PACKAGE_ROOT,
		manifest,
		log: (l) => logs.push(l),
		sleep: async () => undefined,
		env: { PATH: "/usr/bin" },
		samplerIntervalMs: 60_000,
		...(signal !== undefined ? { signal } : {}),
	};
	return { exec, opts, deps, logs, results };
}

const releases = (exec: ReturnType<typeof fakeExec>) =>
	exec.calls.filter((c) => c.cmd === process.execPath && c.args[1] === "release");

describe("runBench", () => {
	test("phase order per framework, cold flag only on rep 1, results validate", async () => {
		const calls: Calls = [];
		const t = setup([adapter("warden", calls), adapter("maestro", calls)]);
		const outcome = await runBench(t.opts, t.deps);
		expect(outcome.success).toBe(true);
		expect(calls).toEqual([
			"warden.doctor",
			"warden.prepare",
			"warden.run:cold",
			"warden.run:warm",
			"warden.run:warm",
			"warden.teardown",
			"maestro.doctor",
			"maestro.prepare",
			"maestro.run:cold",
			"maestro.run:warm",
			"maestro.run:warm",
			"maestro.teardown",
		]);
		if (!outcome.success) return;
		const file = JSON.parse(readFileSync(join(t.opts.out ?? "", "bench-results.json"), "utf8"));
		const parsed = benchRunSchema.safeParse(file);
		expect(parsed.success).toBe(true);
		const run = outcome.data.run;
		expect(run.frameworks.map((f) => f.status)).toEqual(["ok", "ok"]);
		expect(run.device).toMatchObject({ udid: "UDID-1", leaseId: "lease-1", platform: "ios" });
		expect(run.app).toMatchObject({ bundleId: "nz.co.delacour.warden.example", hash: "abc" });
		expect(run.options.caffeinated).toBe(true);
		const first = run.frameworks[0];
		if (first?.status !== "ok") throw new Error("expected ok");
		expect(first.reps.map((r) => [r.index, r.cold, r.rawArtifactDir])).toEqual([
			[1, true, "artifacts/warden/rep-1"],
			[2, false, "artifacts/warden/rep-2"],
			[3, false, "artifacts/warden/rep-3"],
		]);
		expect(first.stats.ratioToFastestSuite).toBeDefined();
		expect(existsSync(join(t.opts.out ?? "", "report.md"))).toBe(true);
		expect(existsSync(join(t.opts.out ?? "", "logs", "bench.log"))).toBe(true);
	});

	test("results are written after every framework", async () => {
		const calls: Calls = [];
		const seen: number[] = [];
		const out = join(dir, "out");
		const watcher = adapter("maestro", calls, {
			async doctor() {
				const text = readFileSync(join(out, "bench-results.json"), "utf8");
				seen.push((JSON.parse(text) as { frameworks: unknown[] }).frameworks.length);
				return { ok: true, version: "2", notes: [] };
			},
		});
		const t = setup([adapter("warden", calls), watcher]);
		await runBench(t.opts, t.deps);
		expect(seen).toEqual([1]);
	});

	test("classification: failed run keeps partial reps, unsupported, doctor failures", async () => {
		const calls: Calls = [];
		let n = 0;
		const flaky = adapter("maestro", calls, {
			async run() {
				n++;
				return n === 1 ? ok(rep(1)) : { success: false, error: failed("boom") };
			},
		});
		const nope = adapter("argent", calls, {
			async run() {
				return { success: false, error: unsupported("RN too new") };
			},
		});
		const noDoctor = adapter("agent-device", calls, {
			async doctor() {
				return { ok: false, reason: "missing", installHint: "bun add -g agent-device" };
			},
		});
		const detox = adapter("detox", calls, {
			async doctor() {
				return { ok: false, reason: "no applesimutils", installHint: "brew install applesimutils" };
			},
		});
		const t = setup([flaky, nope, noDoctor, detox]);
		const outcome = await runBench(t.opts, t.deps);
		if (!outcome.success) throw new Error(outcome.error);
		const [a, b, c, d] = outcome.data.run.frameworks;
		expect(a).toMatchObject({ framework: "maestro", status: "failed", phase: "run", error: "boom" });
		expect(a?.status === "failed" && a.partial?.length).toBe(1);
		expect(b).toMatchObject({ framework: "argent", status: "unsupported", reason: "RN too new", version: "1.0.0" });
		expect(c).toMatchObject({ framework: "agent-device", status: "failed", phase: "doctor" });
		expect(d?.status).toBe("unsupported");
		expect(calls).toContain("maestro.teardown");
		expect(calls).not.toContain("agent-device.prepare");
		expect(
			benchRunSchema.safeParse(JSON.parse(readFileSync(join(dir, "out", "bench-results.json"), "utf8"))).success
		).toBe(true);
	});

	test("prepare failure is phase prepare and still tears down", async () => {
		const calls: Calls = [];
		const bad = adapter("maestro", calls, {
			async prepare() {
				return err("no java");
			},
		});
		const t = setup([bad]);
		const outcome = await runBench(t.opts, t.deps);
		if (!outcome.success) throw new Error(outcome.error);
		expect(outcome.data.run.frameworks[0]).toMatchObject({ status: "failed", phase: "prepare", error: "no java" });
		expect(calls).toEqual(["maestro.doctor", "maestro.teardown"]);
	});

	test("--skip-doctor skips doctor, a platform mismatch is unsupported", async () => {
		const calls: Calls = [];
		const iosOnly = adapter("argent", calls, { supports: ["ios"] });
		const t = setup([adapter("warden", calls), iosOnly], { skipDoctor: true, platform: "android" });
		const outcome = await runBench(t.opts, t.deps);
		if (!outcome.success) throw new Error(outcome.error);
		expect(calls.some((c) => c.endsWith(".doctor"))).toBe(false);
		expect(outcome.data.run.frameworks[1]).toMatchObject({
			framework: "argent",
			status: "unsupported",
			reason: "does not support android",
		});
		expect(outcome.data.run.frameworks[0]).toMatchObject({ status: "ok", version: "unknown" });
	});

	test("the lease is released exactly once, and caffeinate is killed", async () => {
		const calls: Calls = [];
		const t = setup([adapter("warden", calls)]);
		await runBench(t.opts, t.deps);
		expect(releases(t.exec)).toHaveLength(1);
		expect(releases(t.exec)[0]?.args).toEqual(["/cli.ts", "release", "lease-1"]);
		expect(t.exec.started.map((c) => c.cmd)).toEqual(["caffeinate"]);
		expect(t.exec.killed).toEqual(["caffeinate"]);
	});

	test("a caller-leased --udid is never claimed or released", async () => {
		const calls: Calls = [];
		const t = setup([adapter("warden", calls)], { udid: "MINE" });
		const outcome = await runBench(t.opts, t.deps);
		expect(outcome.success).toBe(true);
		expect(t.exec.calls.some((c) => c.args[1] === "claim")).toBe(false);
		expect(releases(t.exec)).toHaveLength(0);
	});

	test("an abort stops after the current framework's teardown and still releases", async () => {
		const calls: Calls = [];
		const controller = new AbortController();
		const first = adapter("warden", calls, {
			async run(ctx) {
				calls.push("warden.run");
				if (ctx.cold) controller.abort();
				return ok(rep(1));
			},
		});
		const t = setup([first, adapter("maestro", calls)], {}, controller.signal);
		const outcome = await runBench(t.opts, t.deps);
		if (!outcome.success) throw new Error(outcome.error);
		expect(outcome.data.interrupted).toBe(true);
		expect(calls).toContain("warden.teardown");
		expect(calls.some((c) => c.startsWith("maestro"))).toBe(false);
		expect(outcome.data.run.frameworks[0]).toMatchObject({ status: "failed", phase: "run", error: "interrupted" });
		expect(releases(t.exec)).toHaveLength(1);
	});

	test("a failed claim aborts before any framework and releases nothing", async () => {
		const calls: Calls = [];
		const t = setup([adapter("warden", calls)]);
		t.exec.calls.length = 0;
		const bad = fakeExec([
			...rules().filter((r) => !(r.cmd === process.execPath && r.match?.(["x", "claim"]))),
			{ cmd: process.execPath, match: (a) => a[1] === "claim", result: { code: 1, stderr: "no devices" } },
		]);
		const outcome = await runBench(t.opts, { ...t.deps, exec: bad });
		expect(outcome.success).toBe(false);
		expect(calls).toEqual([]);
		expect(releases(bad)).toHaveLength(0);
	});
});

describe("helpers", () => {
	test("loadTooHigh", () => {
		expect(loadTooHigh({ loadAvgAtStart: 12.1, cores: 12 })).toBe(true);
		expect(loadTooHigh({ loadAvgAtStart: 3, cores: 12 })).toBe(false);
	});

	test("runStamp", () => {
		expect(runStamp(new Date("2026-10-16T12:07:32.000Z"))).toBe("2026-10-16T12-07-32");
	});

	test("trackingExec records pids from run (onSpawn) and start", async () => {
		const pids = new Set<number>();
		const base = fakeExec([{ cmd: "x", result: {} }]);
		const exec = trackingExec(base, pids);
		exec.start("x", []);
		expect([...pids]).toEqual([1001]);
		await exec.run("x", [], {});
		expect(base.calls[0]?.options?.onSpawn).toBeFunction();
	});

	test("finalizeFrameworks leaves non-ok frameworks alone", () => {
		const f = finalizeFrameworks([{ framework: "detox", status: "unsupported", reason: "r" }]);
		expect(f).toEqual([{ framework: "detox", status: "unsupported", reason: "r" }]);
	});

	test("summaryLines has a header and a row per framework", async () => {
		const calls: Calls = [];
		const t = setup([adapter("warden", calls)]);
		const outcome = await runBench(t.opts, t.deps);
		if (!outcome.success) throw new Error(outcome.error);
		const lines = summaryLines(outcome.data.run);
		expect(lines[0]).toStartWith("framework");
		expect(lines).toHaveLength(2);
		expect(t.logs.join("\n")).toContain("warden");
	});
});
