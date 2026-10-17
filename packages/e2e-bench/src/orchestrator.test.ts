import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@delacour/warden-types/result";
import { type BenchAdapter, type FrameworkId, failed, type RunContext, unsupported } from "./adapters/adapter.types";
import { type Exec, type FakeRule, fakeExec } from "./harness/exec";
import type { ExitCharge, SamplerOptions, Tick } from "./harness/sampler";
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
import { benchRunSchema, CANONICAL_IDS, type HostGroup, type RepResult } from "./results/schema";

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
		expect(existsSync(join(t.opts.out ?? "", "summary.json"))).toBe(true);
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

	describe("android animation scales", () => {
		const KEYS = ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"];

		/** `adb shell settings get|put|delete global <key>` over an in-memory settings table. */
		function settingsRules(settings: Map<string, string>): FakeRule[] {
			const on = (verb: string) => (a: readonly string[]) => a[3] === "settings" && a[4] === verb;
			return [
				{ cmd: "adb", match: on("get"), result: (a) => ({ stdout: `${settings.get(a[6] ?? "") ?? "null"}\n` }) },
				{
					cmd: "adb",
					match: on("put"),
					result: (a) => {
						settings.set(a[6] ?? "", a[7] ?? "");
						return {};
					},
				},
				{
					cmd: "adb",
					match: on("delete"),
					result: (a) => {
						settings.delete(a[6] ?? "");
						return {};
					},
				},
			];
		}

		function android(settings: Map<string, string>, adapters: BenchAdapter[]) {
			const t = setup(adapters, { platform: "android", runs: 1 });
			t.deps.exec = fakeExec([...settingsRules(settings), ...rules()], { which: ["caffeinate"] });
			return t;
		}

		const zeroing = (calls: Calls, settings: Map<string, string>): BenchAdapter =>
			adapter("warden", calls, {
				async run() {
					for (const key of KEYS) settings.set(key, "0");
					return ok(rep(1));
				},
			});

		test("a framework that zeroes them does not leak that into the next framework", async () => {
			const settings = new Map(KEYS.map((key) => [key, "1.0"]));
			const seen: (string | undefined)[] = [];
			const observer = adapter("maestro", [], {
				async run() {
					seen.push(settings.get("window_animation_scale"));
					return ok(rep(1));
				},
			});
			const t = android(settings, [zeroing([], settings), observer]);
			const outcome = await runBench(t.opts, t.deps);
			expect(outcome.success).toBe(true);
			expect(seen).toEqual(["1.0"]);
		});

		test("the device is left as it was found, even when the last framework zeroed them", async () => {
			const settings = new Map(KEYS.map((key) => [key, "1.0"]));
			const t = android(settings, [zeroing([], settings)]);
			await runBench(t.opts, t.deps);
			expect(KEYS.map((key) => settings.get(key))).toEqual(["1.0", "1.0", "1.0"]);
		});
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

	test("the lease is heartbeated every 60 s during the reps and the timer is cleared at the end (19-2)", async () => {
		const calls: Calls = [];
		let beat: () => void = () => undefined;
		const schedule: { ms?: number; cancelled: number } = { cancelled: 0 };
		const heartbeats = (exec: ReturnType<typeof fakeExec>) =>
			exec.calls.filter((c) => c.cmd === process.execPath && c.args[1] === "heartbeat");
		const long = adapter("warden", calls, {
			async run(ctx) {
				calls.push(`warden.run:${ctx.cold ? "cold" : "warm"}`);
				beat();
				return ok(rep(1));
			},
		});
		const t = setup([long]);
		t.exec.calls.length = 0;
		const outcome = await runBench(t.opts, {
			...t.deps,
			heartbeatEvery: (fn, ms) => {
				beat = fn;
				schedule.ms = ms;
				return () => {
					schedule.cancelled += 1;
				};
			},
		});
		await Bun.sleep(0);
		expect(outcome.success).toBe(true);
		expect(schedule.ms).toBe(60_000);
		expect(heartbeats(t.exec).map((c) => c.args)).toEqual([
			["/cli.ts", "heartbeat", "lease-1"],
			["/cli.ts", "heartbeat", "lease-1"],
			["/cli.ts", "heartbeat", "lease-1"],
		]);
		expect(schedule.cancelled).toBe(1);
		const claim = t.exec.calls.find((c) => c.args[1] === "claim");
		expect(claim?.args).toEqual(["/cli.ts", "claim", "ios", "--ttl", "4h", "--label", "bench", "--json"]);
	});

	test("no heartbeat for a caller-leased --udid (the caller holds that lease)", async () => {
		const calls: Calls = [];
		const t = setup([adapter("warden", calls)], { udid: "MINE" });
		let scheduled = false;
		await runBench(t.opts, {
			...t.deps,
			heartbeatEvery: () => {
				scheduled = true;
				return () => undefined;
			},
		});
		expect(scheduled).toBe(false);
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

describe("per-rep resources (19-6)", () => {
	/** A sampler whose clock is a counter the test advances; ticks are canned. */
	function fakeSampler(
		ticks: Tick[],
		seen: { options?: SamplerOptions; marks: number[]; exited?: [number, number][] },
		exits: ExitCharge[] = []
	) {
		let clock = 0;
		return {
			advance: (ms: number) => {
				clock += ms;
			},
			start: (options: SamplerOptions) => {
				seen.options = options;
				return {
					elapsed: () => {
						seen.marks.push(clock);
						return clock;
					},
					exited: (pid: number, cpuSec: number) => {
						seen.exited?.push([pid, cpuSec]);
					},
					stop: async () => ({
						exits,
						host: { cpuAvgPct: 0, cpuPeakPct: 0, rssAvgBytes: 0, rssPeakBytes: 0, samples: ticks.length },
						sim: { cpuAvgPct: 0, cpuPeakPct: 0, rssAvgBytes: 0, rssPeakBytes: 0, samples: ticks.length },
						ticks,
					}),
				};
			},
		};
	}

	const tick = (t: number, hostCpuSec: number): Tick => ({
		t,
		hostCpuPct: 0,
		hostRssBytes: t,
		simCpuPct: 0,
		simRssBytes: 0,
		hostCpuSec,
	});

	test("each rep stores the resources of its timed run only, not prepare / teardown / terminate", async () => {
		const calls: Calls = [];
		// prepare 0..1000 (busy), rep runs at 1000..2000, 2500..3500, 4000..5000; 1 CPU-s per 500 ms tick
		const ticks = Array.from({ length: 13 }, (_, i) => tick(i * 500, i === 0 ? 0 : 1));
		const seen: { options?: SamplerOptions; marks: number[] } = { marks: [] };
		const sampler = fakeSampler(ticks, seen);
		const busy = adapter("warden", calls, {
			async prepare() {
				sampler.advance(1000);
				return ok(undefined);
			},
			async run() {
				sampler.advance(1000);
				return ok(rep(1));
			},
		});
		const t = setup([busy]);
		const terminate = t.deps.exec.run;
		t.deps.exec = {
			...t.deps.exec,
			run: async (cmd, args, options) => {
				// isolation also terminates the app, before the sampler starts
				if (cmd === "xcrun" && args.includes("terminate") && seen.options !== undefined) sampler.advance(500);
				return terminate(cmd, args, options);
			},
		};
		const outcome = await runBench(t.opts, { ...t.deps, startSampler: sampler.start });
		if (!outcome.success) throw new Error(outcome.error);
		const f = outcome.data.run.frameworks[0];
		if (f?.status !== "ok") throw new Error("expected ok");
		expect(f.reps.map((r) => r.resources?.window)).toEqual([
			{ startMs: 1500, endMs: 2500 },
			{ startMs: 3000, endMs: 4000 },
			{ startMs: 4500, endMs: 5500 },
		]);
		expect(f.reps.map((r) => r.resources?.cpuSeconds)).toEqual([2, 2, 2]);
		expect(f.reps[0]?.resources?.rssPeakBytes).toBe(2500);
		expect(f.resources.host.samples).toBe(13);
		expect(seen.options?.rootLabels).toBeFunction();
	});

	test("a run child's CPU at exit reaches the sampler, and its charge lands in that rep's window (bench-fidelity-R4)", async () => {
		const calls: Calls = [];
		const ticks = Array.from({ length: 13 }, (_, i) => tick(i * 500, i === 0 ? 0 : 1));
		const seen: { options?: SamplerOptions; marks: number[]; exited: [number, number][] } = { marks: [], exited: [] };
		const sampler = fakeSampler(ticks, seen, [{ t: 2000, cpuSec: 0.25, group: "bun-test" }]);
		const runner = adapter("warden", calls, {
			async prepare() {
				sampler.advance(1000);
				return ok(undefined);
			},
			async run(ctx) {
				sampler.advance(1000);
				await ctx.exec.run("fake-runner", ["test"]);
				return ok(rep(1));
			},
		});
		const t = setup([runner]);
		const base = t.deps.exec.run;
		t.deps.exec = {
			...t.deps.exec,
			run: async (cmd, args, options) => {
				if (cmd === "xcrun" && args.includes("terminate") && seen.options !== undefined) sampler.advance(500);
				if (cmd !== "fake-runner") return base(cmd, args, options);
				options?.onSpawn?.(7000 + seen.exited.length);
				return { code: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, cpuSec: 0.5 };
			},
		};
		const outcome = await runBench(t.opts, { ...t.deps, startSampler: sampler.start });
		if (!outcome.success) throw new Error(outcome.error);
		const f = outcome.data.run.frameworks[0];
		if (f?.status !== "ok") throw new Error("expected ok");
		expect(seen.exited).toEqual([
			[7000, 0.5],
			[7001, 0.5],
			[7002, 0.5],
		]);
		expect(f.reps.map((r) => r.resources?.cpuSeconds)).toEqual([2.25, 2, 2]);
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

	test("trackingExec labels each spawned pid with its host group (warden CLI, bun test, adb, other)", async () => {
		const pids = new Set<number>();
		const labels = new Map<number, HostGroup>();
		const base = fakeExec([{ cmd: "x", result: {} }]);
		const exec = trackingExec(base, pids, labels);
		exec.start("/opt/bun", ["/repo/apps/cli/src/cli.ts", "ui", "snapshot"]);
		exec.start("/opt/bun", ["test", "--preload", "p"]);
		exec.start("/opt/sdk/platform-tools/adb", ["-s", "e"]);
		exec.start("/opt/homebrew/bin/maestro", ["test"]);
		expect([...labels]).toEqual([
			[1001, "warden-cli"],
			[1002, "bun-test"],
			[1003, "adb"],
			[1004, "other"],
		]);
		await exec.run("/opt/bun", ["test"], {});
		base.calls.at(-1)?.options?.onSpawn?.(4242);
		expect(labels.get(4242)).toBe("bun-test");
	});

	test("trackingExec hands each run's CPU time at exit to onExit with its pid (bench-fidelity-R4)", async () => {
		const base: Exec = {
			...fakeExec(),
			run: async (_cmd, _args, options) => {
				options?.onSpawn?.(4242);
				return { code: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, cpuSec: 0.75 };
			},
		};
		const exits: [number, number][] = [];
		const exec = trackingExec(base, new Set(), new Map(), (pid, cpuSec) => exits.push([pid, cpuSec]));
		await exec.run("/opt/bun", ["test"]);
		expect(exits).toEqual([[4242, 0.75]]);
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
		expect(lines[0]).not.toContain("cpu-s/rep");
		expect(lines).toHaveLength(2);
		const f = outcome.data.run.frameworks[0];
		if (f?.status !== "ok") throw new Error("expected ok");
		// no ps here: no CPU time, so the reps carry none and the console keeps the legacy columns (bench-fidelity-R1)
		expect(f.reps.every((r) => r.resources === undefined || r.resources.cpuSeconds === undefined)).toBe(true);
		const timed = structuredClone(outcome.data.run);
		const tf = timed.frameworks[0];
		if (tf?.status !== "ok") throw new Error("expected ok");
		tf.reps = tf.reps.map((r) => ({
			...r,
			resources: {
				window: { startMs: 0, endMs: 1 },
				host: tf.resources.host,
				sim: tf.resources.sim,
				cpuSeconds: 1.5,
				rssPeakBytes: 0,
			},
		}));
		expect(summaryLines(timed)[0]).toContain("cpu-s/rep");
		expect(summaryLines(timed)[1]).toContain("1.50 s");
		expect(t.logs.join("\n")).toContain("warden");
	});
});
