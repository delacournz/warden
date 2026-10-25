import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildProfile, buildSourceMap, type FakeCdp, fakeCdp } from "@delacour/warden-perf/js/js.testing";
import { jsOk } from "@delacour/warden-perf/js/js.types";
import type { LogStream } from "@delacour/warden-perf/logs/pid-follow";
import { decodeSamples } from "@delacour/warden-perf/metrics/series";
import { ok } from "@delacour/warden-types/result";
import { type TestContext, testContext } from "../testing";
import { type CollectorDeps, runSessionCollector } from "./collector";
import type { JsSession } from "./js-capture";
import { type PerfPlan, writePlan } from "./plan";
import { createSession, readSession, sessionDir, stopSession } from "./session";
import { asMe, fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const T0 = 20_000_000;
const EMU = "emulator-5554";
const APP = "com.acme.shop";
const METRO = "http://127.0.0.1:8081";
const BUNDLE = `${METRO}/index.bundle?platform=android`;

const TOP = " 4321 u0_a123      10 -10  14G 250M 120M S  25.0   6.5   0:30.11 com.acme.shop\n";

const plan = (over: Partial<PerfPlan> = {}): PerfPlan => ({
	version: 1,
	app: APP,
	cwd: "/app",
	metrics: false,
	frames: false,
	logs: false,
	js: false,
	react: false,
	relaunch: false,
	metroUrl: METRO,
	...over,
});

const profile = buildProfile(
	[
		{ id: 1, name: "(root)", children: [2] },
		{ id: 2, name: "render", url: BUNDLE, scriptId: "7", line: 0, column: 0 },
	],
	[
		[2, 1000],
		[2, 1000],
	]
);

function profilerCdp(): FakeCdp {
	return fakeCdp(
		{
			"Profiler.stop": { profile },
			"Runtime.evaluate": (params) =>
				String(params?.expression).includes("__DEV__")
					? { result: { type: "boolean", value: true } }
					: { result: { type: "number", value: 1_700_000_000_000 } },
		},
		{ "Debugger.enable": [{ scriptId: "7", url: BUNDLE, sourceMapURL: `${METRO}/index.map` }] }
	);
}

type Harness = ReturnType<typeof setup>;

function setup(opts: { maxDurationMs?: number; plan?: Partial<PerfPlan>; logSpawnThrows?: boolean } = {}) {
	const clock = { now: T0 };
	const c = testContext([], {
		now: () => clock.now,
		exec: async (cmd) => {
			const line = cmd.join(" ");
			if (line.includes("pidof")) return { exitCode: 0, stdout: "4321\n", stderr: "" };
			if (line.includes("shell top")) return { exitCode: 0, stdout: TOP, stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "" };
		},
	});
	ctx = c;
	asMe(c);
	const perfDeps = fakePerfDeps([{ platform: "android", id: EMU, name: "pixel" }], {}, { metro: async () => METRO });
	const made = createSession(c, perfDeps.session, {
		device: { udid: EMU, platform: "android", name: "pixel" },
		target: { udid: EMU, ownedByCaller: false },
		app: { id: APP, source: "flag" },
		maxDurationMs: opts.maxDurationMs ?? 5_000,
	});
	if (!made.success) throw new Error(made.error.message);
	const id = made.data.id;
	writePlan(c, id, plan(opts.plan));

	const hooks = { sleeps: 0, onSleep: (_n: number) => {} };
	const sleep = async (ms: number) => {
		hooks.sleeps++;
		clock.now += ms;
		hooks.onSleep(hooks.sleeps);
		await Bun.sleep(0);
	};
	const cdp = profilerCdp();
	let closed = 0;
	let opened = 0;
	const session: JsSession = { ...cdp, close: () => closed++ };
	const logArgv: string[][] = [];
	const logKills: number[] = [];
	const log: string[] = [];
	const finalized: string[] = [];
	const snapshots: Array<Record<string, string>> = [];
	const deps: CollectorDeps = {
		js: {
			open: async () => {
				opened++;
				return ok(session);
			},
			fetchMap: async () => jsOk(buildSourceMap(["/app/src/Feed.tsx"], [[[0, 0, 41, 2]]])),
			sleep: async (ms, signal) => {
				const until = clock.now + ms;
				while (!signal?.aborted && clock.now < until) await Bun.sleep(0);
			},
		},
		logs: {
			spawn: (argv, onLine) => {
				if (opts.logSpawnThrows) throw new Error("logcat exploded");
				logArgv.push(argv);
				onLine("I/App: hello password=hunter2");
				onLine("I/App: second");
				let resolve: (n: number) => void = () => {};
				const exited = new Promise<number>((r) => {
					resolve = r;
				});
				const stream: LogStream = {
					kill: () => {
						logKills.push(1);
						resolve(0);
					},
					exited,
				};
				return stream;
			},
			sleep,
			interrupt: () => ({ signal: new AbortController().signal, dispose: () => {} }),
		},
		sleep,
		log: (line) => log.push(line),
		finalize: async (sid) => {
			finalized.push(sid);
			const s = readSession(c, sid);
			snapshots.push(Object.fromEntries((s?.capturers ?? []).map((x) => [x.kind, x.state])));
		},
	};
	return {
		c,
		clock,
		perfDeps,
		id,
		deps,
		hooks,
		cdp,
		log,
		logArgv,
		logKills,
		finalized,
		snapshots,
		closes: () => closed,
		opens: () => opened,
	};
}

const states = (h: Harness) =>
	Object.fromEntries((readSession(h.c, h.id)?.capturers ?? []).map((x) => [x.kind, x.state]));

describe("runSessionCollector", () => {
	test("an unknown session or one with no plan is missing and starts nothing", async () => {
		const h = setup();
		const none = await runSessionCollector(
			h.c,
			h.perfDeps,
			h.deps,
			"20260101-000000-abcdef",
			new AbortController().signal
		);
		expect(none).toEqual({ success: true, data: "missing" });
		expect(h.finalized).toEqual([]);
		expect(h.hooks.sleeps).toBe(0);
	});

	test("starts exactly the requested capturers", async () => {
		const h = setup({ plan: { metrics: true, logs: true } });
		await runSessionCollector(h.c, h.perfDeps, h.deps, h.id, new AbortController().signal);
		expect(Object.keys(states(h)).sort()).toEqual(["logs", "metrics"]);
		expect(h.opens()).toBe(0);
		expect(h.logArgv).toHaveLength(1);
	});

	test("metrics: one sample per tick, timed from the session start on the injected clock", async () => {
		const h = setup({ plan: { metrics: true }, maxDurationMs: 4_000 });
		await runSessionCollector(h.c, h.perfDeps, h.deps, h.id, new AbortController().signal);
		const rows = decodeSamples(readFileSync(join(sessionDir(h.c, h.id), "metrics", "samples.jsonl"), "utf8"));
		expect(rows.length).toBeGreaterThanOrEqual(2);
		expect(rows[0]).toMatchObject({ pid: 4321, cpuPct: 25 });
		for (const r of rows) expect(r.atMs).toBe(r.wallMs - T0);
		const at = rows.map((r) => r.atMs);
		expect(at).toEqual([...at].sort((a, b) => a - b));
		expect(new Set(at).size).toBe(at.length);
		expect(at.every((ms) => ms % 1000 === 0)).toBe(true);
		expect(readSession(h.c, h.id)?.capturers.find((x) => x.kind === "metrics")).toMatchObject({
			state: "stopped",
			out: join(sessionDir(h.c, h.id), "metrics", "samples.jsonl"),
		});
	});

	test("logs: redacted lines land in logs/device.log and the stream is killed on stop", async () => {
		const h = setup({ plan: { logs: true } });
		await runSessionCollector(h.c, h.perfDeps, h.deps, h.id, new AbortController().signal);
		const text = readFileSync(join(sessionDir(h.c, h.id), "logs", "device.log"), "utf8");
		expect(text).toContain("I/App: second");
		expect(text).not.toContain("hunter2");
		expect(h.logKills.length).toBeGreaterThanOrEqual(1);
		expect(h.logArgv[0]?.join(" ")).toContain("--pid 4321");
		expect(states(h)).toMatchObject({ logs: "stopped" });
	});

	test("the cap ends the run: captures flush, then finalize runs exactly once", async () => {
		const h = setup({ plan: { metrics: true, logs: true }, maxDurationMs: 3_000 });
		const r = await runSessionCollector(h.c, h.perfDeps, h.deps, h.id, new AbortController().signal);
		expect(r).toEqual({ success: true, data: "capped" });
		expect(h.finalized).toEqual([h.id]);
		expect(h.snapshots[0]).toEqual({ metrics: "stopped", logs: "stopped" });
		expect(existsSync(join(sessionDir(h.c, h.id), "metrics", "samples.jsonl"))).toBe(true);
		expect(existsSync(join(sessionDir(h.c, h.id), "logs", "device.log"))).toBe(true);
	});

	test("an abort stops early, flushes captures and never finalizes", async () => {
		const h = setup({ plan: { metrics: true, logs: true }, maxDurationMs: 120_000 });
		const stop = new AbortController();
		h.hooks.onSleep = (n) => {
			if (n === 6) stop.abort();
		};
		const r = await runSessionCollector(h.c, h.perfDeps, h.deps, h.id, stop.signal);
		expect(r).toEqual({ success: true, data: "aborted" });
		expect(h.finalized).toEqual([]);
		expect(h.clock.now).toBeLessThan(T0 + 120_000);
		expect(states(h)).toEqual({ metrics: "stopped", logs: "stopped" });
		expect(readFileSync(join(sessionDir(h.c, h.id), "logs", "device.log"), "utf8")).toContain("I/App: second");
		expect(readFileSync(join(sessionDir(h.c, h.id), "metrics", "samples.jsonl"), "utf8").length).toBeGreaterThan(0);
	});

	test("an already-aborted signal runs no ticks and no finalize", async () => {
		const h = setup({ plan: { metrics: true }, maxDurationMs: 120_000 });
		const stop = new AbortController();
		stop.abort();
		const r = await runSessionCollector(h.c, h.perfDeps, h.deps, h.id, stop.signal);
		expect(r).toEqual({ success: true, data: "aborted" });
		expect(h.finalized).toEqual([]);
	});

	test("a session someone else stopped ends the run without finalize", async () => {
		const h = setup({ plan: { metrics: true }, maxDurationMs: 120_000 });
		h.hooks.onSleep = (n) => {
			if (n === 2) stopSession(h.c, h.perfDeps.session, h.id, "user", { signalCollector: false });
		};
		const r = await runSessionCollector(h.c, h.perfDeps, h.deps, h.id, new AbortController().signal);
		expect(r).toEqual({ success: true, data: "ended" });
		expect(h.finalized).toEqual([]);
	});

	test("a failing capturer is recorded as failed and the others keep running", async () => {
		const h = setup({ plan: { metrics: true, logs: true }, maxDurationMs: 4_000, logSpawnThrows: true });
		const r = await runSessionCollector(h.c, h.perfDeps, h.deps, h.id, new AbortController().signal);
		expect(r).toEqual({ success: true, data: "capped" });
		expect(states(h)).toEqual({ logs: "failed", metrics: "stopped" });
		expect(h.log.join("\n")).toContain("logs: logcat exploded");
		const rows = decodeSamples(readFileSync(join(sessionDir(h.c, h.id), "metrics", "samples.jsonl"), "utf8"));
		expect(rows.length).toBeGreaterThanOrEqual(2);
		expect(h.finalized).toEqual([h.id]);
	});

	test("js: holds the inspector socket for the whole capture, then writes the profile and closes it once", async () => {
		const h = setup({ plan: { js: true }, maxDurationMs: 120_000 });
		const stop = new AbortController();
		let midRun: { stopSent: boolean; closed: number } | undefined;
		h.hooks.onSleep = (n) => {
			if (n === 3) midRun = { stopSent: h.cdp.sent.some((s) => s.method === "Profiler.stop"), closed: h.closes() };
			if (n === 4) stop.abort();
		};
		const r = await runSessionCollector(h.c, h.perfDeps, h.deps, h.id, stop.signal);
		expect(r).toEqual({ success: true, data: "aborted" });
		expect(midRun).toEqual({ stopSent: false, closed: 0 });
		expect(h.cdp.sent.some((s) => s.method === "Profiler.stop")).toBe(true);
		expect(h.closes()).toBe(1);
		const dir = join(sessionDir(h.c, h.id), "js");
		expect(existsSync(join(dir, "cpu.cpuprofile"))).toBe(true);
		expect(JSON.parse(readFileSync(join(dir, "hotspots.json"), "utf8")).topSelf[0]).toMatchObject({ name: "render" });
		expect(readSession(h.c, h.id)?.capturers.find((x) => x.kind === "js")).toMatchObject({
			state: "stopped",
			out: dir,
		});
	});

	test("no Metro target: js and react are failed, metrics still run, the socket is never opened", async () => {
		const h = setup({ plan: { js: true, react: true, metrics: true }, maxDurationMs: 4_000 });
		h.deps.js.open = async () => ({ success: false, error: { code: "devtools_unavailable", message: "no target" } });
		const r = await runSessionCollector(h.c, h.perfDeps, h.deps, h.id, new AbortController().signal);
		expect(r).toEqual({ success: true, data: "capped" });
		expect(states(h)).toEqual({ js: "failed", react: "failed", metrics: "stopped" });
		expect(h.log.join("\n")).toContain("devtools:");
		expect(h.closes()).toBe(0);
	});
});
