import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecResult } from "@delacour/warden-core/exec";
import { traceProcessorPin } from "@delacour/warden-perf/android/trace-processor.data";
import { type TestContext, testContext } from "../testing";
import type { PerfTarget } from "./device";
import { type AndroidNativeDeps, createAndroidNativeProfiler } from "./native-android";
import type { NativeHandle, NativeIo } from "./native-types";
import { fakePerfDeps } from "./testing";

const fixture = (n: string) => readFileSync(join(import.meta.dir, "../../../../packages/perf/fixtures", n), "utf8");
const TARGET: PerfTarget = {
	udid: "emulator-5554",
	platform: "android",
	ownedByCaller: true,
	source: "booted",
	mode: "observe",
};
const APP = "com.shop.app";
const io: NativeIo = {
	spawnDetached: () => ({ pid: 0 }),
	kill: () => {},
	pidAlive: () => false,
	sleep: async () => {},
};

type Env = {
	c: TestContext;
	calls: string[][];
	stdinCalls: Array<{ argv: readonly string[]; stdin: string }>;
	deps: AndroidNativeDeps;
	/** how many `test -d /proc/<pid>` polls answer "alive" before the process is gone */
	aliveFor: { n: number };
	dir: string;
};

let env: Env;
afterEach(() => env?.c.cleanup());

const done = (stdout = "", exitCode = 0, stderr = ""): ExecResult => ({ exitCode, stdout, stderr });

function setup(
	opts: {
		packageDump?: string;
		pidof?: string;
		queryOutputs?: Record<string, string>;
		perfettoStart?: ExecResult;
		extraEnv?: Record<string, string>;
	} = {}
): Env {
	const calls: string[][] = [];
	const stdinCalls: Env["stdinCalls"] = [];
	const aliveFor = { n: 1 };
	let tick = 0;
	const c = testContext(["perf", "native"], { now: () => (tick += 500) });
	c.env = { ...c.env, ...opts.extraEnv };
	const dir = join(c.env.WARDEN_HOME ?? "", "native");
	c.exec = async (cmd) => {
		calls.push([...cmd]);
		const j = cmd.join(" ");
		if (j.includes("date +%s%N")) return done("1730000000123456789\n");
		if (j.includes("dumpsys package")) return done(opts.packageDump ?? fixture("dumpsys-package-debuggable.txt"));
		if (j.includes("pidof")) return done(opts.pidof ?? "4242\n");
		if (j.includes("test -d /proc/")) {
			if (aliveFor.n > 0) {
				aliveFor.n--;
				return done();
			}
			return done("", 1);
		}
		return fakeOther(cmd, j);
	};
	const fakeOther = async (cmd: readonly string[], j: string): Promise<ExecResult> => {
		if (cmd.includes("pull")) {
			const local = cmd.at(-1) ?? "";
			mkdirSync(join(local, ".."), { recursive: true });
			writeFileSync(local, "binary");
			return done();
		}
		if (j.includes("simpleperf record")) return done("7001\n");
		if (j.includes("simpleperf report")) return done(fixture("simpleperf-report.txt"));
		if (cmd[1] === "--query-file" || cmd[0]?.endsWith("tp-fake")) {
			const file = cmd[2] ?? "";
			const name = /queries\/(.+)\.sql$/.exec(file)?.[1] ?? "";
			return done(opts.queryOutputs?.[name] ?? "");
		}
		return done();
	};
	const deps: AndroidNativeDeps = {
		execWithStdin: async (argv, stdin) => {
			stdinCalls.push({ argv, stdin });
			return opts.perfettoStart ?? done(fixture("perfetto-start-output.txt"));
		},
		traceProcessor: {
			fetch: async () => {
				throw new Error("no network in tests");
			},
			platform: "darwin",
			arch: "arm64",
			writeErr: () => {},
			now: () => 1,
			pinFor: () => undefined,
		},
		stopTimeoutMs: 5_000,
		pollMs: 1,
	};
	env = { c, calls, stdinCalls, deps, aliveFor, dir };
	return env;
}

const profiler = () => createAndroidNativeProfiler(env.deps);
const perfDeps = () => fakePerfDeps([]);

async function started(flavor?: string): Promise<NativeHandle> {
	const res = await profiler().start(env.c, perfDeps(), io, {
		target: TARGET,
		app: APP,
		dir: env.dir,
		leaks: false,
		maxDurationMs: 30_000,
		...(flavor !== undefined ? { flavor } : {}),
	});
	if (!res.success) throw new Error(res.error.message);
	return res.data;
}

describe("start", () => {
	test("perfetto: config on stdin, pid parsed, artifact path and clock anchors in the handle", async () => {
		setup();
		const handle = await started();
		expect(env.stdinCalls).toHaveLength(1);
		const { argv, stdin } = env.stdinCalls[0] ?? { argv: [], stdin: "" };
		expect(argv.join(" ")).toContain(
			"shell perfetto --txt -c - --background-wait -o /data/misc/perfetto-traces/warden-"
		);
		expect(stdin).toContain('target_cmdline: "com.shop.app"');
		expect(stdin).toContain("duration_ms: 30000");
		expect(handle.out).toBe(join(env.dir, "android.perfetto-trace"));
		expect(handle.state).toMatchObject({ mode: "perfetto", devicePid: 12345 });
		expect(handle.deviceWallMs).toBe(1730000000123);
		expect(handle.pid).toBeUndefined();
	});

	test("warns on stderr when the app is neither debuggable nor profileable", async () => {
		setup({ packageDump: fixture("dumpsys-package-release.txt") });
		await started();
		expect(env.c.stderr.join("\n")).toContain("profileable");
		expect(env.c.stderr.join("\n")).toContain('<profileable android:shell="true"/>');
	});

	test("perfetto that prints no pid is a failure with its stderr", async () => {
		setup({ perfettoStart: done("", 1, "perfetto: permission denied") });
		const res = await profiler().start(env.c, perfDeps(), io, {
			target: TARGET,
			app: APP,
			dir: env.dir,
			leaks: false,
			maxDurationMs: 1000,
		});
		expect(res).toMatchObject({ success: false, error: { code: "failed" } });
		expect(res.success ? "" : res.error.message).toContain("permission denied");
	});

	test("simpleperf: scopes to the app pid and records the device pid", async () => {
		setup();
		const handle = await started("simpleperf");
		const line = env.calls.find((x) => x.join(" ").includes("simpleperf record"))?.at(-1) ?? "";
		expect(line).toContain("-p 4242");
		expect(handle.out).toBe(join(env.dir, "simpleperf.data"));
		expect(handle.state).toMatchObject({ mode: "simpleperf", devicePid: 7001, hz: 4000 });
		expect(env.stdinCalls).toEqual([]);
	});

	test("simpleperf with the app not running is app_not_found", async () => {
		setup({ pidof: "" });
		const res = await profiler().start(env.c, perfDeps(), io, {
			target: TARGET,
			app: APP,
			dir: env.dir,
			leaks: false,
			flavor: "simpleperf",
			maxDurationMs: 1000,
		});
		expect(res).toMatchObject({ success: false, error: { code: "app_not_found" } });
	});

	test("rejects a package that is not a package name before touching the device", async () => {
		setup();
		const res = await profiler().start(env.c, perfDeps(), io, {
			target: TARGET,
			app: 'x"; rm',
			dir: env.dir,
			leaks: false,
			maxDurationMs: 1000,
		});
		expect(res).toMatchObject({ success: false, error: { code: "usage" } });
		expect(env.stdinCalls).toEqual([]);
	});
});

describe("stop", () => {
	test("perfetto: TERM, wait for /proc/<pid> to go, pull, rm", async () => {
		setup();
		const handle = await started();
		const res = await profiler().stop(env.c, perfDeps(), io, {
			target: TARGET,
			app: APP,
			dir: env.dir,
			handle,
			analyze: false,
		});
		expect(res).toMatchObject({ success: true, data: { out: handle.out, warnings: [] } });
		const verbs = env.calls.map((x) => x.slice(3).join(" "));
		const term = verbs.indexOf("shell kill -TERM 12345");
		const pull = verbs.findIndex((v) => v.startsWith("pull /data/misc/perfetto-traces/warden-"));
		const rm = verbs.findIndex((v) => v.startsWith("shell rm -f /data/misc/perfetto-traces/warden-"));
		expect(term).toBeGreaterThan(-1);
		expect(pull).toBeGreaterThan(term);
		expect(rm).toBeGreaterThan(pull);
		expect(existsSync(handle.out)).toBe(true);
	});

	test("a recorder that ignores TERM is KILLed and the trace flagged incomplete", async () => {
		setup();
		const handle = await started();
		env.aliveFor.n = 1_000_000;
		const res = await profiler().stop(env.c, perfDeps(), io, {
			target: TARGET,
			app: APP,
			dir: env.dir,
			handle,
			analyze: false,
		});
		expect(env.calls.some((x) => x.join(" ").endsWith("kill -KILL 12345"))).toBe(true);
		expect(res.success && res.data.warnings[0]).toContain("did not exit");
	});

	test("simpleperf: INT first, saves the on-device report, and analysis needs no trace_processor", async () => {
		setup();
		const handle = await started("simpleperf");
		const res = await profiler().stop(env.c, perfDeps(), io, {
			target: TARGET,
			app: APP,
			dir: env.dir,
			handle,
			analyze: true,
		});
		expect(env.calls.some((x) => x.join(" ").endsWith("kill -INT 7001"))).toBe(true);
		expect(res.success).toBe(true);
		if (!res.success) return;
		expect(res.data.analysis?.findings.map((f) => f.kind)).toEqual([
			"native-hotspot",
			"native-hotspot",
			"native-hotspot",
		]);
		expect(res.data.analysis?.section.title).toContain("simpleperf");
		expect(existsSync(`${handle.out}.report.txt`)).toBe(true);
	});

	test("missing trace_processor never loses the pulled trace: analysis is skipped with the install hint", async () => {
		setup();
		const handle = await started();
		const res = await profiler().stop(env.c, perfDeps(), io, {
			target: TARGET,
			app: APP,
			dir: env.dir,
			handle,
			analyze: true,
		});
		expect(res.success).toBe(true);
		if (!res.success) return;
		expect(res.data.analysis).toBeUndefined();
		expect(res.data.warnings.join("\n")).toContain("warden perf tools install trace-processor --yes");
		expect(existsSync(handle.out)).toBe(true);
	});

	test("a failed pull is an error", async () => {
		setup();
		const handle = await started();
		const run = env.c.exec;
		env.c.exec = async (cmd, o) => (cmd.includes("pull") ? done("", 1, "remote object does not exist") : run(cmd, o));
		const res = await profiler().stop(env.c, perfDeps(), io, {
			target: TARGET,
			app: APP,
			dir: env.dir,
			handle,
			analyze: false,
		});
		expect(res).toMatchObject({ success: false, error: { code: "failed" } });
	});
});

describe("analyze", () => {
	function withTp(outputs: Record<string, string>): Env {
		const e = setup({ queryOutputs: outputs });
		const tp = join(e.c.env.WARDEN_HOME ?? "", "tp-fake");
		writeFileSync(tp, "#!/bin/sh");
		e.c.env = { ...e.c.env, WARDEN_TRACE_PROCESSOR: tp };
		const trace = join(e.dir, "android.perfetto-trace");
		mkdirSync(e.dir, { recursive: true });
		writeFileSync(trace, "x");
		return e;
	}

	const outputs = {
		"cpu-hotspots": fixture("trace-processor-cpu-hotspots.txt"),
		"ui-hangs": fixture("trace-processor-ui-hangs.txt"),
		"hang-folds-batched": fixture("trace-processor-hang-folds.txt"),
		"thread-breakdown":
			'"thread","tid","running_ns","runnable_ns","io_ns","sleeping_ns"\n"mqt_v_js",4300,900000000,40000000,0,10000000\n',
		"memory-rss": fixture("trace-processor-memory-rss.txt"),
	};

	test("runs the five queries with --query-file and reports CPU, hangs and RSS findings", async () => {
		withTp(outputs);
		const res = await profiler().analyze(env.c, perfDeps(), {
			target: TARGET,
			app: APP,
			dir: env.dir,
			trace: join(env.dir, "android.perfetto-trace"),
		});
		expect(res.success).toBe(true);
		if (!res.success) return;
		const ran = env.calls
			.filter((x) => x[1] === "--query-file")
			.map((x) => /queries\/(.+)\.sql$/.exec(x[2] ?? "")?.[1]);
		expect(ran).toEqual(["cpu-hotspots", "ui-hangs", "hang-folds-batched", "thread-breakdown", "memory-rss"]);
		const sql = readFileSync(join(env.dir, "queries", "cpu-hotspots.sql"), "utf8");
		expect(sql).toContain("p.name = 'com.shop.app'");
		const kinds = res.data.findings.map((f) => f.kind);
		expect(kinds).toContain("native-hotspot");
		expect(kinds).toContain("hang");
		expect(kinds).toContain("memory-growth");
		expect(res.data.section.lines.join("\n")).toContain("mqt_v_js");
		expect(existsSync(res.data.files.analysis ?? "")).toBe(true);
	});

	test("zero samples is not_profileable with the manifest snippet", async () => {
		withTp({ ...outputs, "cpu-hotspots": '"thread","function","dso","samples"\n' });
		const res = await profiler().analyze(env.c, perfDeps(), {
			target: TARGET,
			app: APP,
			dir: env.dir,
			trace: join(env.dir, "android.perfetto-trace"),
		});
		expect(res).toMatchObject({ success: false, error: { code: "not_profileable" } });
		expect(res.success ? "" : res.error.hint).toContain('<profileable android:shell="true"/>');
	});

	test("a window keeps only the hangs inside it", async () => {
		withTp(outputs);
		const res = await profiler().analyze(env.c, perfDeps(), {
			target: TARGET,
			app: APP,
			dir: env.dir,
			trace: join(env.dir, "android.perfetto-trace"),
			windowMs: { startMs: 0, endMs: 1000 },
		});
		expect(res.success && res.data.findings.some((f) => f.kind === "hang")).toBe(false);
	});

	test("without trace_processor and without --yes: tool_missing", async () => {
		setup();
		mkdirSync(env.dir, { recursive: true });
		writeFileSync(join(env.dir, "android.perfetto-trace"), "x");
		const res = await profiler().analyze(env.c, perfDeps(), {
			target: TARGET,
			app: APP,
			dir: env.dir,
			trace: join(env.dir, "android.perfetto-trace"),
		});
		expect(res).toMatchObject({ success: false, error: { code: "tool_missing" } });
	});

	test("yes: true downloads without asking (the input flag, not argv)", async () => {
		setup();
		mkdirSync(env.dir, { recursive: true });
		writeFileSync(join(env.dir, "android.perfetto-trace"), "x");
		const fetched: string[] = [];
		const deps: AndroidNativeDeps = {
			...env.deps,
			traceProcessor: {
				...env.deps.traceProcessor,
				pinFor: traceProcessorPin,
				fetch: async (url) => {
					fetched.push(url);
					throw new Error("offline");
				},
			},
		};
		await createAndroidNativeProfiler(deps).analyze(env.c, perfDeps(), {
			target: TARGET,
			app: APP,
			dir: env.dir,
			trace: join(env.dir, "android.perfetto-trace"),
			yes: true,
		});
		expect(fetched).toHaveLength(1);
		expect(fetched[0]).toEndWith("/trace_processor_shell");
	});
});
