import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecResult } from "@delacour/warden-core/exec";
import type { Owner } from "@delacour/warden-core/types";
import { ok } from "@delacour/warden-types/result";
import { type TestContext, testContext } from "../testing";
import type { PerfTarget } from "./device";
import type { NativeProfiler } from "./native-types";
import { chooseCapturers, finalizeSession, type SessionKit, type StartOptions, startPerf } from "./orchestrate";
import { readPlan } from "./plan";
import { perfRecord } from "./record";
import { listSessions, readSession, sessionDir, updateSession } from "./session";
import { perfStart } from "./start";
import { perfStop } from "./stop";
import { asMe, fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const fx = (name: string) =>
	readFileSync(new URL(`../../../../packages/perf/fixtures/${name}`, import.meta.url), "utf8");

const EMU = "emulator-5554";
const APP = "com.acme.shop";
const T0 = 10_000_000;
const other: Owner = { kind: "agent", sessionId: "other", cwd: "/" };

type Rule = [needle: string, result: Partial<ExecResult> | (() => Partial<ExecResult>)];

function setup(rules: Rule[] = []) {
	const clock = { now: T0 };
	const calls: string[] = [];
	const all: Rule[] = [
		...rules,
		["date +%s%N", () => ({ stdout: `${(clock.now + 250) * 1_000_000}\n` })],
		["force-stop", {}],
		["resolve-activity", { stdout: fx("resolve-activity.txt") }],
		["am start", { stdout: fx("am-start-cold.txt") }],
		["pidof", { stdout: "4321\n" }],
		["gfxinfo", { stdout: fx("gfxinfo-60hz.txt") }],
		["logcat -b crash", { stdout: "" }],
		["dumpsys dropbox", { stdout: "" }],
	];
	const c = testContext([], {
		now: () => clock.now,
		exec: async (cmd) => {
			const line = cmd.join(" ");
			calls.push(line);
			const hit = all.find(([needle]) => line.includes(needle));
			if (!hit) return { exitCode: 127, stdout: "", stderr: `no rule: ${line}` };
			const result = typeof hit[1] === "function" ? hit[1]() : hit[1];
			return { exitCode: 0, stdout: "", stderr: "", ...result };
		},
	});
	ctx = c;
	asMe(c);
	c.db.recordDevice({ platform: "android", id: EMU, name: "pixel" }, T0);
	const deps = fakePerfDeps(
		[{ platform: "android", id: EMU, name: "pixel" }],
		{},
		{ metro: async () => "http://localhost:8081" }
	);
	const spawned: string[][] = [];
	const nativeCalls: string[] = [];
	const profiler: NativeProfiler = {
		start: async (_c, _d, _io, input) => {
			nativeCalls.push("start");
			mkdirSync(input.dir, { recursive: true });
			return ok({
				pid: 777,
				out: join(input.dir, "android.perfetto-trace"),
				startedAtIso: "x",
				startWallMs: clock.now,
			});
		},
		stop: async (_c, _d, _io, input) => {
			nativeCalls.push("stop");
			return ok({
				out: input.handle.out,
				warnings: [],
				analysis: {
					findings: [],
					section: { title: "Native CPU (Android Perfetto)", lines: ["main thread busy"] },
					summary: ["native: 10 samples"],
					files: {},
					report: {
						mode: "perfetto",
						cpu: { functions: [{ thread: "main", function: "layout", selfPct: 12 }] },
						hangs: { hangs: [{ atMs: 3200, durMs: 412, jankType: "App Deadline Missed" }] },
					},
					warnings: [],
				},
			});
		},
		analyze: async () => ({ success: false, error: { code: "failed", message: "unused" } }),
	};
	const kit: SessionKit = {
		io: {
			spawnDetached: ({ argv }) => {
				spawned.push(argv);
				const id = argv[argv.indexOf("--session") + 1] ?? "";
				deps.session.alive.add(4242);
				deps.session.commands.set(4242, `warden perf-collect --session ${id}`);
				return { pid: 4242 };
			},
			kill: () => {},
			pidAlive: () => true,
			sleep: async (ms) => {
				clock.now += ms;
				const open = listSessions(c)[0];
				if (open !== undefined) {
					for (const kind of ["metrics", "logs"] as const) {
						if (!open.capturers.some((cap) => cap.kind === kind))
							updateSession(c, open.id, (s) => ({
								...s,
								capturers: [...s.capturers, { kind, startedAtIso: "x", state: "running" as const }],
							}));
					}
				}
			},
			self: () => ["warden"],
		},
		profilers: { ios: async () => profiler, android: async () => profiler },
	};
	return { c, clock, calls, deps, kit, spawned, nativeCalls };
}

const target = (over: Partial<PerfTarget> = {}): PerfTarget => ({
	udid: EMU,
	platform: "android",
	name: "pixel",
	ownedByCaller: false,
	source: "booted",
	mode: "observe",
	...over,
});

describe("chooseCapturers", () => {
	test("none named: metrics, frames and logs", () => {
		expect(chooseCapturers({})).toEqual({
			success: true,
			data: { metrics: true, frames: true, logs: true, js: false, react: false },
		});
	});

	test("--all is everything including native", () => {
		const r = chooseCapturers({ all: true });
		expect(r).toMatchObject({ success: true, data: { js: true, react: true, native: { flavor: "" } } });
	});

	test("a flavor must be perfetto or simpleperf", () => {
		expect(chooseCapturers({ native: "bogus" }).success).toBe(false);
		expect(chooseCapturers({ native: "simpleperf" })).toMatchObject({
			success: true,
			data: { native: { flavor: "simpleperf" }, metrics: false },
		});
	});
});

const startOpts = (o: Partial<StartOptions>): StartOptions => ({ record: false, ...o });

describe("startPerf", () => {
	test("opens a session, writes the plan, anchors the device clock and spawns the collector", async () => {
		const { c, deps, kit, spawned } = setup();
		const r = await startPerf(c, deps, kit, target(), startOpts({ app: APP, metrics: true, logs: true }));
		if (!r.success) throw new Error(r.error.message);
		const { session, plan } = r.data;
		expect(session.startedAt).toEqual({ wallMs: T0, deviceWallMs: T0 + 250 });
		expect(session.app).toEqual({ id: APP, source: "flag" });
		expect(plan).toMatchObject({ app: APP, metrics: true, logs: true, js: false, relaunch: false });
		expect(readPlan(c, session.id)).toEqual(plan);
		expect(spawned).toEqual([["warden", "perf-collect", "--session", session.id]]);
		expect(session.capturers.find((x) => x.kind === "collector")?.pid).toBe(4242);
		expect(r.data.warnings).toEqual([]);
	});

	test("--max-duration beyond 5m is clamped with a warning", async () => {
		const { c, deps, kit } = setup();
		const r = await startPerf(c, deps, kit, target(), startOpts({ app: APP, metrics: true, maxDuration: "10m" }));
		if (!r.success) throw new Error(r.error.message);
		expect(r.data.session.maxDurationMs).toBe(300_000);
		expect(r.data.warnings[0]).toContain("capped at 5m");
	});

	test("a second start on the device is session_active", async () => {
		const { c, deps, kit } = setup();
		await startPerf(c, deps, kit, target(), startOpts({ app: APP, metrics: true }));
		const again = await startPerf(c, deps, kit, target(), startOpts({ app: APP, metrics: true }));
		expect(again).toMatchObject({ success: false, error: { code: "session_active" } });
	});

	test("js/react without Metro fail those capturers with a warning, not the session", async () => {
		const { c, deps, kit } = setup();
		deps.host.metro = async () => undefined;
		const r = await startPerf(c, deps, kit, target(), startOpts({ app: APP, js: true, react: true }));
		if (!r.success) throw new Error(r.error.message);
		expect(r.data.plan).toMatchObject({ js: false, react: false });
		expect(
			r.data.session.capturers
				.filter((x) => x.state === "failed")
				.map((x) => x.kind)
				.sort()
		).toEqual(["js", "react"]);
		expect(r.data.warnings.join("\n")).toContain("no Metro");
	});

	test("--relaunch on a free device takes a perf lease, arms Android native before launch and records the launch", async () => {
		const { c, deps, kit, calls, nativeCalls } = setup();
		const r = await startPerf(
			c,
			deps,
			kit,
			target(),
			startOpts({ app: APP, relaunch: true, native: true, metrics: true })
		);
		if (!r.success) throw new Error(r.error.message);
		expect(r.data.leaseId).toBeDefined();
		expect(c.db.listLeases().map((l) => l.label)).toEqual(["warden perf"]);
		const order = calls.map((l) => (l.includes("force-stop") ? "stop" : l.includes("am start") ? "launch" : ""));
		expect(order.filter(Boolean)).toEqual(["stop", "launch"]);
		expect(nativeCalls).toEqual(["start"]);
		const startup = JSON.parse(readFileSync(join(sessionDir(c, r.data.session.id), "metrics", "startup.json"), "utf8"));
		expect(startup).toMatchObject({ method: "am-start", summary: { cold: { medianMs: 1834 } } });
		expect(r.data.launch?.kind).toBe("launched");
	});

	test("--relaunch on a device someone else holds is device_foreign and starts nothing", async () => {
		const { c, deps, kit, spawned } = setup();
		c.db.insertLease(
			{ resource: { kind: "device", platform: "android", id: EMU, name: "pixel" }, owner: other, ttlMs: 60_000 },
			c.now()
		);
		const r = await startPerf(c, deps, kit, target({ holder: "agent other" }), startOpts({ app: APP, relaunch: true }));
		expect(r).toMatchObject({ success: false, error: { code: "device_foreign" } });
		expect(spawned).toEqual([]);
		expect(c.db.listLeases()).toHaveLength(1);
	});

	test("a failed launch aborts the session and gives the lease back", async () => {
		const { c, deps, kit } = setup([["am start", { stdout: fx("am-start-error.txt") }]]);
		const r = await startPerf(c, deps, kit, target(), startOpts({ app: APP, relaunch: true }));
		expect(r.success).toBe(false);
		expect(c.db.listLeases()).toEqual([]);
		expect(listSessions(c).map((s) => s.status)).toEqual(["aborted"]);
	});
});

describe("finalizeSession", () => {
	async function started(opts: Partial<StartOptions>) {
		const s = setup();
		const r = await startPerf(s.c, s.deps, s.kit, target(), startOpts(opts));
		if (!r.success) throw new Error(r.error.message);
		return { ...s, id: r.data.session.id };
	}

	test("signals the collector, stops native, gathers frames, releases the lease and writes the report", async () => {
		const { c, deps, kit, id, nativeCalls } = await started({
			app: APP,
			relaunch: true,
			native: true,
			metrics: true,
			frames: true,
		});
		mkdirSync(join(sessionDir(c, id), "metrics"), { recursive: true });
		writeFileSync(
			join(sessionDir(c, id), "metrics", "samples.jsonl"),
			[1, 2, 3]
				.map((n) =>
					JSON.stringify({
						wallMs: T0 + n * 1000,
						atMs: n * 1000,
						pid: 1,
						cpuPct: n * 10,
						rssKb: 100_000 + n,
						pssKb: 120_000 + n,
					})
				)
				.join("\n")
		);
		deps.session.alive.add(4242);
		const r = await finalizeSession(c, deps, kit, id, { reason: "user" });
		if (!r.success) throw new Error(r.error.message);
		expect(deps.session.killed).toEqual([[4242, "SIGTERM"]]);
		expect(nativeCalls).toEqual(["start", "stop"]);
		expect(c.db.listLeases()).toEqual([]);
		expect(readSession(c, id)).toMatchObject({ status: "stopped", stopReason: "user" });
		const report = r.data.report;
		expect(report?.metrics).toMatchObject({ cpuP95Pct: 30, hangCount: 1, startupColdMs: 1834 });
		expect(report?.sections.map((s) => s.id)).toEqual(["startup", "frames", "native-cpu", "hangs", "memory", "logs"]);
		expect(existsSync(join(sessionDir(c, id), "report.md"))).toBe(true);
		expect(existsSync(join(sessionDir(c, id), "report.json"))).toBe(true);
		expect(existsSync(join(sessionDir(c, id), "frames.json"))).toBe(true);
	});

	test("never signals a collector pid that is no longer the collector", async () => {
		const { c, deps, kit, id } = await started({ app: APP, metrics: true });
		deps.session.commands.set(4242, "some other process");
		deps.session.alive.add(4242);
		await finalizeSession(c, deps, kit, id, { reason: "user", analyze: false });
		expect(deps.session.killed).toEqual([]);
	});

	test("--no-analyze stops without a report; finalize again builds it later", async () => {
		const { c, deps, kit, id } = await started({ app: APP, metrics: true });
		const r = await finalizeSession(c, deps, kit, id, { reason: "user", analyze: false });
		if (!r.success) throw new Error(r.error.message);
		expect(r.data.report).toBeUndefined();
		expect(existsSync(join(sessionDir(c, id), "report.json"))).toBe(false);
		const again = await finalizeSession(c, deps, kit, id, { reason: "user" });
		expect(again.success && again.data.report?.sessionId).toBe(id);
	});

	test("an unknown session is session_not_found", async () => {
		const { c, deps, kit } = setup();
		expect(await finalizeSession(c, deps, kit, "20260101-000000-abcdef", { reason: "user" })).toMatchObject({
			success: false,
			error: { code: "session_not_found" },
		});
	});
});

describe("start / stop / record commands", () => {
	test("start --json then stop --json: the report is the result", async () => {
		const { c, deps, kit } = setup();
		expect(await perfStart(c, deps, { record: true, json: true, app: APP, metrics: true }, kit)).toBe(0);
		const started = JSON.parse(c.stdout.join("\n"));
		expect(started).toMatchObject({ ok: true, command: "perf start", result: { app: APP } });
		c.stdout.length = 0;
		expect(await perfStop(c, deps, { record: true, json: true }, kit)).toBe(0);
		const stopped = JSON.parse(c.stdout.join("\n"));
		expect(stopped.result.sessionId).toBe(started.result.sessionId);
		expect(stopped.result.report.version).toBe(1);
	});

	test("start --join attaches read-only to the running session", async () => {
		const { c, deps, kit } = setup();
		await perfStart(c, deps, { record: true, json: true, app: APP, metrics: true }, kit);
		const id = JSON.parse(c.stdout.join("\n")).result.sessionId;
		c.stdout.length = 0;
		expect(await perfStart(c, deps, { record: true, json: true, join: true }, kit)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).result).toMatchObject({ sessionId: id, joined: true });
		expect(c.db.listLeases()).toEqual([]);
	});

	test("stop with no session is session_not_found", async () => {
		const { c, deps, kit } = setup();
		expect(await perfStop(c, deps, { record: true, json: true }, kit)).toBe(1);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ error: { code: "session_not_found" } });
	});

	test("record waits the duration, then reports; the cap defaults to duration + 10s", async () => {
		const { c, clock, deps, kit } = setup();
		const code = await perfRecord(c, deps, { record: true, json: true, app: APP, metrics: true, duration: "5s" }, kit, {
			interrupt: () => ({ signal: new AbortController().signal, dispose: () => {} }),
		});
		expect(code).toBe(0);
		const doc = JSON.parse(c.stdout.join("\n"));
		expect(doc.command).toBe("perf record");
		expect(readSession(c, doc.result.sessionId)?.maxDurationMs).toBe(15_000);
		expect(clock.now - T0).toBeGreaterThanOrEqual(5000);
	});

	test("Ctrl-C ends the wait early: still reported, exit 130", async () => {
		const { c, deps, kit } = setup();
		const controller = new AbortController();
		controller.abort();
		const code = await perfRecord(c, deps, { record: true, json: true, app: APP, metrics: true, duration: "5m" }, kit, {
			interrupt: () => ({ signal: controller.signal, dispose: () => {} }),
		});
		expect(code).toBe(130);
		expect(JSON.parse(c.stdout.join("\n")).result.report.version).toBe(1);
	});

	test("record rejects a duration over 5m", async () => {
		const { c, deps, kit } = setup();
		expect(await perfRecord(c, deps, { record: true, json: true, app: APP, duration: "6m" }, kit)).toBe(1);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ error: { code: "usage" } });
	});
});
