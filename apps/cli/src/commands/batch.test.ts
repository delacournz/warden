import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE } from "@warden/core/builds/config";
import type { ExecOptions, ExecResult } from "@warden/core/exec";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { createBatchCommand } from "./batch";
import { harness } from "./batch.testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function setup(argv: string[]): TestContext {
	ctx = testContext(argv, { exec: fakeSimctl([wardenSim(1, "Booted"), wardenSim(2, "Booted")]) });
	ctx.env = { ...ctx.env, ...OWNER_ENV };
	return ctx;
}

async function waitFor(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(1);
}

type BatchJson = {
	batchId: string;
	cmd: string[];
	startedAt: number;
	endedAt: number;
	ok: boolean;
	devices: Array<{ worker: number; udid: string; name: string; video?: string; videoStartedAt?: number }>;
	jobs: Array<{
		job: string;
		worker: number;
		udid: string;
		seq: number;
		attempt: number;
		startedAt: number;
		endedAt: number;
		exitCode: number;
	}>;
};

describe("warden batch", () => {
	test("fans jobs over the leased devices with per-job argv + env, logs, releases, exit 0", async () => {
		const c = setup(["ios", "--count", "2", "--jobs", "a,b,c", "--", "run", "{job}", "--on={udid}", "w{worker}s{seq}"]);
		const h = harness();
		expect(await createBatchCommand(h.deps).run(c)).toBe(0);
		const jobs = h.jobs();
		expect(jobs.map((j) => j.opts.env.WARDEN_JOB)).toEqual(["a", "b", "c"]);
		const a = jobs[0];
		const udid = a?.opts.env.WARDEN_UDID;
		expect(a?.cmd).toEqual(["run", "a", `--on=${udid}`, `w${a?.opts.env.WARDEN_WORKER}s0`]);
		expect(a?.opts.env.WARDEN_JOB_SEQ).toBe("0");
		expect(a?.opts.env.WARDEN_UDIDS?.split(",").sort()).toEqual(["U1", "U2"]);
		expect(a?.opts.env.WARDEN_SESSION_ID).toBe("me");
		const batchDir = join(c.env.WARDEN_HOME ?? "", "batches", "b1");
		expect(a?.opts.env.WARDEN_BATCH_DIR).toBe(batchDir);
		expect(a?.opts.log).toBe(join(batchDir, "logs", `${a?.opts.env.WARDEN_WORKER}-0-a.log`));
		expect(h.dirs).toContain(join(batchDir, "logs"));
		expect(a?.opts.cwd).toBe(c.cwd);
		const summary = JSON.parse(h.files.get(join(batchDir, "batch.json")) ?? "{}") as BatchJson;
		expect(summary).toMatchObject({ batchId: "b1", ok: true, cmd: ["run", "{job}", "--on={udid}", "w{worker}s{seq}"] });
		expect(summary.devices.map((d) => d.udid).sort()).toEqual(["U1", "U2"]);
		expect(summary.jobs.map((j) => j.job).sort()).toEqual(["a", "b", "c"]);
		expect(summary.jobs[0]).toMatchObject({ attempt: 0, exitCode: 0 });
		expect(c.db.listLeases()).toEqual([]);
		expect(h.signals.size).toBe(0);
		expect(c.stderr.join("\n")).toContain("3/3 passed");
	});

	test("a failing job (after --retry) → exit 1; retried on the same worker", async () => {
		const c = setup(["ios", "--jobs", "ok,bad", "--retry", "1", "--", "x", "{job}"]);
		const h = harness({ exitCodes: { bad: 4 } });
		expect(await createBatchCommand(h.deps).run(c)).toBe(1);
		const bad = h.jobs().filter((j) => j.opts.env.WARDEN_JOB === "bad");
		expect(bad.map((j) => j.opts.env.WARDEN_JOB_SEQ)).toEqual(["1", "2"]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("--passes N: a job passes only after N consecutive green runs; the first red one stops it", async () => {
		const c = setup(["ios", "--jobs", "ok,flaky", "--passes", "2", "--", "x", "{job}"]);
		const h = harness({ exitCodeFor: (env) => (env.WARDEN_JOB === "flaky" && env.WARDEN_PASS === "1" ? 5 : 0) });
		expect(await createBatchCommand(h.deps).run(c)).toBe(1);
		const runs = h.jobs().map((j) => `${j.opts.env.WARDEN_JOB}:${j.opts.env.WARDEN_PASS}`);
		expect(runs.sort()).toEqual(["flaky:0", "flaky:1", "ok:0", "ok:1"]);
		const okLogs = h
			.jobs()
			.filter((j) => j.opts.env.WARDEN_JOB === "ok")
			.map((j) => j.opts.log.split("/").at(-1));
		expect(okLogs).toEqual([expect.stringMatching(/-0-ok\.pass0\.log$/), expect.stringMatching(/-0-ok\.pass1\.log$/)]);
		const summary = JSON.parse(h.files.get(join(c.env.WARDEN_HOME ?? "", "batches", "b1", "batch.json")) ?? "{}");
		expect(summary.jobs.find((j: { job: string }) => j.job === "flaky").exitCode).toBe(5);
	});

	test("--passes must be >= 1", async () => {
		const c = setup(["ios", "--jobs", "a", "--passes", "0", "--", "x"]);
		expect(await createBatchCommand(harness().deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--passes");
	});

	test("--jobs-from file and stdin (-)", async () => {
		const c = setup(["ios", "--jobs-from", "jobs.txt", "--", "x"]);
		const h = harness();
		h.files.set(join(c.cwd, "jobs.txt"), "one\n# no\ntwo\n");
		expect(await createBatchCommand(h.deps).run(c)).toBe(0);
		expect(h.jobs().map((j) => j.opts.env.WARDEN_JOB)).toEqual(["one", "two"]);

		c.argv = ["ios", "--jobs-from", "-", "--", "x"];
		c.readStdin = async () => "s1\ns2\n";
		const h2 = harness();
		expect(await createBatchCommand(h2.deps).run(c)).toBe(0);
		expect(h2.jobs().map((j) => j.opts.env.WARDEN_JOB)).toEqual(["s1", "s2"]);
	});

	test("usage errors → exit 1 before anything is claimed", async () => {
		for (const argv of [
			["ios", "--", "x"],
			["ios", "--jobs", "a", "--jobs-from", "f", "--", "x"],
			["ios", "--jobs", ",", "--", "x"],
			["ios", "--jobs", "a"],
			["ios", "--jobs", "a", "--retry", "-1", "--", "x"],
			["ios", "--jobs", "a", "--serve-ready", "tcp:1", "--", "x"],
			["ios", "--jobs", "a", "--serve", "s", "--serve-ready", "nope", "--", "x"],
			["ios", "--jobs", "a", "--serve", "s", "--serve-timeout", "soon", "--", "x"],
			["android", "--jobs", "a", "--record", "r", "--", "x"],
		]) {
			const c = setup(argv);
			const h = harness();
			expect(await createBatchCommand(h.deps).run(c)).toBe(1);
			expect(h.spawned).toEqual([]);
			expect(c.db.listLeases()).toEqual([]);
			ctx?.cleanup();
		}
		const c = setup(["android", "--jobs", "a", "--record", "r", "--", "x"]);
		await createBatchCommand(harness().deps).run(c);
		expect(c.stderr.join("\n")).toContain("--record is iOS-only");
	});

	test("--serve: own process group with the lease env, jobs wait for ready, then SIGTERM", async () => {
		const c = setup([
			"ios",
			"--count",
			"2",
			"--jobs",
			"a,b",
			"--serve",
			"bun metro",
			"--serve-ready",
			"tcp:8091",
			"--",
			"x",
		]);
		let polls = 0;
		const h = harness({ ready: () => ++polls >= 3 });
		expect(await createBatchCommand(h.deps).run(c)).toBe(0);
		const serve = h.serve();
		expect(serve?.cmd).toEqual(["sh", "-c", "bun metro"]);
		expect(serve?.opts.env.WARDEN_UDIDS?.split(",").sort()).toEqual(["U1", "U2"]);
		expect(serve?.opts.log).toBe(join(c.env.WARDEN_HOME ?? "", "batches", "b1", "logs", "serve.log"));
		expect(h.probes).toHaveLength(3);
		expect(h.probes[0]).toEqual({ kind: "tcp", host: "127.0.0.1", port: 8091 });
		expect(h.events).toEqual(["serve:start", "job:a", "job:b", "serve:SIGTERM"]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("salient invocation: --label, --max, --port, --serve-timeout 20m, file: ready, --jobs-from -, --retry", async () => {
		const c = setup([
			"ios",
			"--count",
			"2",
			"--max",
			"5",
			"--profile",
			"iphone-17",
			"--label",
			"salient-e2e",
			"--port",
			"8091:20",
			"--serve",
			"bun session",
			"--serve-ready",
			"file:e2e-artifacts/batch/session.json",
			"--serve-timeout",
			"20m",
			"--jobs-from",
			"-",
			"--retry",
			"1",
			"--",
			"bun",
			"run-ios.ts",
			"--attach",
			"{job}",
			"--device",
			"{udid}",
		]);
		c.readStdin = async () => "qa-a\nqa-b\n";
		const h = harness({ exitCodes: { "qa-b": 1 } });
		let labels: Array<string | undefined> = [];
		const spawn = h.deps.spawn;
		h.deps.spawn = (cmd, o) => {
			labels = c.db.listLeases().map((l) => `${l.resource.kind}:${l.label}`);
			return spawn(cmd, o);
		};
		expect(await createBatchCommand(h.deps).run(c)).toBe(1);
		expect(labels.sort()).toEqual(["device:salient-e2e", "device:salient-e2e", "port:salient-e2e"]);
		expect(h.probes[0]).toEqual({ kind: "file", path: join(c.cwd, "e2e-artifacts/batch/session.json") });
		expect(h.serve()?.opts).toMatchObject({ group: true, cwd: c.cwd });
		expect(h.serve()?.opts.env.WARDEN_PORT_0).toBeDefined();
		const b = h.jobs().filter((j) => j.opts.env.WARDEN_JOB === "qa-b");
		expect(b.map((j) => j.opts.env.WARDEN_JOB_SEQ)).toEqual(["0", "1"]);
		expect(new Set(b.map((j) => j.opts.env.WARDEN_WORKER)).size).toBe(1);
		expect(b[0]?.cmd).toEqual(["bun", "run-ios.ts", "--attach", "qa-b", "--device", b[0]?.opts.env.WARDEN_UDID ?? ""]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("serve ignoring SIGTERM gets SIGKILL", async () => {
		const c = setup(["ios", "--jobs", "a", "--serve", "s", "--", "x"]);
		const h = harness({ serveExitsOnKill: false });
		expect(await createBatchCommand(h.deps).run(c)).toBe(0);
		expect(h.serve()?.kills).toEqual(["SIGTERM", "SIGKILL"]);
	});

	test("serve exits before ready → exit 1, no jobs, leases released", async () => {
		const c = setup(["ios", "--jobs", "a", "--serve", "s", "--serve-ready", "file:ready", "--", "x"]);
		const h = harness({ ready: () => false });
		const running = createBatchCommand(h.deps).run(c);
		await waitFor(() => h.serve() !== undefined);
		h.serve()?.finish(2);
		expect(await running).toBe(1);
		expect(h.jobs()).toEqual([]);
		expect(c.stderr.join("\n")).toContain("serve exited (2) before ready");
		expect(c.db.listLeases()).toEqual([]);
	});

	test("serve never ready → timeout → exit 1, serve killed", async () => {
		const c = setup([
			"ios",
			"--jobs",
			"a",
			"--serve",
			"s",
			"--serve-ready",
			"tcp:1",
			"--serve-timeout",
			"2s",
			"--",
			"x",
		]);
		const h = harness({ ready: () => false });
		let clock = c.now();
		c.now = () => {
			clock += 600;
			return clock;
		};
		expect(await createBatchCommand(h.deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("not ready after 2s");
		expect(h.serve()?.kills[0]).toBe("SIGTERM");
		expect(c.db.listLeases()).toEqual([]);
	});

	test("--record: one recording per device after serve is ready; stopped after serve; batch.json + tui.cast", async () => {
		const c = setup(["ios", "--count", "2", "--jobs", "a,b", "--serve", "s", "--record", "rec", "--", "x"]);
		const h = harness();
		expect(await createBatchCommand(h.deps).run(c)).toBe(0);
		const rec = join(c.cwd, "rec");
		const order = h.events.map((e) => e.replace(/U\d/, "U"));
		expect(order.slice(0, 3)).toEqual([
			"serve:start",
			`record:U:${join(rec, "dev-0.mp4")}`,
			`record:U:${join(rec, "dev-1.mp4")}`,
		]);
		expect(order.slice(-3)).toEqual(["serve:SIGTERM", "record-stop:U", "record-stop:U"]);
		expect(h.jobs()[0]?.opts.env.WARDEN_BATCH_DIR).toBe(rec);
		expect(h.jobs()[0]?.opts.log?.startsWith(join(rec, "logs"))).toBe(true);
		const summary = JSON.parse(h.files.get(join(rec, "batch.json")) ?? "{}") as BatchJson;
		expect(summary.devices.map((d) => [d.worker, d.video, d.videoStartedAt])).toEqual([
			[0, "dev-0.mp4", 1_000_500],
			[1, "dev-1.mp4", 1_000_500],
		]);
		const cast = h.files.get(join(rec, "tui.cast")) ?? "";
		expect(JSON.parse(cast.split("\n")[0] ?? "{}")).toMatchObject({ version: 2 });
		expect(cast).toContain("warden batch");
		expect(c.db.listLeases()).toEqual([]);
	});

	test("SIGINT: running jobs get SIGINT, no new jobs, serve then recordings stop, exit 130", async () => {
		const c = setup(["ios", "--jobs", "a,b,c", "--serve", "s", "--record", "rec", "--", "x"]);
		const h = harness({ manual: true });
		const running = createBatchCommand(h.deps).run(c);
		await waitFor(() => h.jobs().length > 0);
		h.signals.get("SIGINT")?.();
		expect(h.jobs()[0]?.kills).toEqual(["SIGINT"]);
		h.jobs()[0]?.finish(130);
		expect(await running).toBe(130);
		expect(h.jobs()).toHaveLength(1);
		expect(h.events.slice(-2).map((e) => e.replace(/U\d/, "U"))).toEqual(["serve:SIGTERM", "record-stop:U"]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("TTY: live grid redraws on the terminal; --no-tui: plain lines", async () => {
		const c = setup(["ios", "--jobs", "a", "--", "x"]);
		const h = harness({ isTTY: true });
		expect(await createBatchCommand(h.deps).run(c)).toBe(0);
		expect(h.terminal.join("")).toContain("warden batch");
		expect(h.terminal.join("")).toContain("\u001b[?25h");
		expect(c.stderr.join("\n")).not.toContain("▶ a");

		c.argv = ["ios", "--jobs", "a", "--no-tui", "--", "x"];
		const h2 = harness({ isTTY: true });
		expect(await createBatchCommand(h2.deps).run(c)).toBe(0);
		expect(h2.terminal).toEqual([]);
		expect(c.stderr.join("\n")).toContain("▶ a");
	});

	test("--json: batch.json shape on stdout only", async () => {
		const c = setup(["ios", "--jobs", "a", "--json", "--", "x"]);
		const h = harness();
		expect(await createBatchCommand(h.deps).run(c)).toBe(0);
		const out = JSON.parse(c.stdout.join("\n")) as BatchJson;
		expect(out).toMatchObject({ batchId: "b1", ok: true });
		expect(out.jobs).toHaveLength(1);
	});

	test("--app ensures the app on every device before serve and jobs", async () => {
		const c = setup(["ios", "--count", "2", "--jobs", "a,b", "--app", "--", "x"]);
		const h = harness();
		const seen: string[] = [];
		h.deps.ensureApp = async (_ctx, _owner, _platform, deviceId) => {
			seen.push(deviceId);
			return { success: true, data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true } };
		};
		expect(await createBatchCommand(h.deps).run(c)).toBe(0);
		expect(seen.sort()).toEqual(["U1", "U2"]);
		expect(h.jobs()[0]?.opts.env.WARDEN_APP_PATH).toBe("/c/A.app");
	});

	test("--app exports WARDEN_APP_PATH / WARDEN_APP_HASH to serve as well as jobs", async () => {
		const c = setup(["ios", "--jobs", "a", "--app", "--serve", "s", "--", "x"]);
		const h = harness();
		h.deps.ensureApp = async () => ({
			success: true,
			data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true },
		});
		expect(await createBatchCommand(h.deps).run(c)).toBe(0);
		for (const proc of [h.serve(), h.jobs()[0]]) {
			expect(proc?.opts.env).toMatchObject({ WARDEN_APP_PATH: "/c/A.app", WARDEN_APP_HASH: "H" });
		}
	});

	test("--logs overrides the log dir", async () => {
		const c = setup(["ios", "--jobs", "Some Job", "--logs", "L", "--", "x"]);
		const h = harness();
		expect(await createBatchCommand(h.deps).run(c)).toBe(0);
		expect(h.jobs()[0]?.opts.log).toBe(join(c.cwd, "L", "0-0-some-job.log"));
	});

	describe("presets (warden.config.json batches)", () => {
		const salient = {
			project: "salient",
			platform: "ios",
			count: 5,
			max: 5,
			profile: "iphone-17",
			ports: ["8091:20"],
			app: true,
			retry: 1,
			env: { E2E_SESSION_FILE: "e2e-artifacts/batch/session.json" },
			serve: "bun scripts/e2e/run-ios.ts --session",
			serveReady: "file:e2e-artifacts/batch/session.json",
			serveTimeout: "20m",
			jobsFrom: { command: "bun scripts/e2e/select-flows.ts --list --offline" },
			cmd: ["bun", "scripts/e2e/run-ios.ts", "--attach", "{job}", "--device", "{udid}"],
		};

		function writeConfig(dir: string, config: unknown): void {
			writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config));
		}

		type ShCall = { cmd: string[]; opts?: ExecOptions };

		/** Answer `sh -c …` (the `{ command }` jobs source) with `result`; everything else goes to simctl. */
		function fakeSh(c: TestContext, result: Partial<ExecResult>): ShCall[] {
			const calls: ShCall[] = [];
			const base = c.exec;
			c.exec = async (cmd, opts) => {
				if (cmd[0] !== "sh") return base(cmd, opts);
				calls.push({ cmd: [...cmd], ...(opts ? { opts } : {}) });
				return { exitCode: 0, stdout: "", stderr: "", ...result };
			};
			return calls;
		}

		test("salient preset: project cwd, {command} jobs, preset env + app env in serve and jobs, label on every lease", async () => {
			const c = setup(["salient-e2e", "--count", "2"]);
			c.env = { ...c.env, E2E_FLOWS: "qa-a,qa-b", E2E_CHANGED_FROM: "main" };
			const root = join(c.cwd, "apps/salient/app");
			mkdirSync(root, { recursive: true });
			writeConfig(c.cwd, {
				projects: [{ name: "salient", root: "apps/salient/app", bundleId: { ios: "nz.x.salient" } }],
				batches: { "salient-e2e": salient },
			});
			const sh = fakeSh(c, { stdout: "qa-a\n\nqa-b\n" });
			const h = harness({ exitCodes: { "qa-b": 1 } });
			const ensured: Array<string | undefined> = [];
			h.deps.ensureApp = async (_ctx, _owner, _platform, _id, opts) => {
				ensured.push(opts.project);
				return { success: true, data: { appPath: "/c/S.app", hash: "SH", source: "cache", installed: true } };
			};
			let labels: string[] = [];
			const spawn = h.deps.spawn;
			h.deps.spawn = (cmd, o) => {
				labels = c.db.listLeases().map((l) => `${l.resource.kind}:${l.label}`);
				return spawn(cmd, o);
			};
			expect(await createBatchCommand(h.deps).run(c)).toBe(1);
			expect(sh).toHaveLength(1);
			expect(sh[0]?.cmd).toEqual(["sh", "-c", "bun scripts/e2e/select-flows.ts --list --offline"]);
			expect(sh[0]?.opts?.cwd).toBe(root);
			expect(sh[0]?.opts?.env).toMatchObject({
				E2E_SESSION_FILE: "e2e-artifacts/batch/session.json",
				E2E_FLOWS: "qa-a,qa-b",
				E2E_CHANGED_FROM: "main",
				HOME: c.env.HOME,
			});
			expect(ensured).toEqual([root, root]);
			expect(labels.sort()).toEqual(["device:salient-e2e", "device:salient-e2e", "port:salient-e2e"]);
			expect(h.probes[0]).toEqual({ kind: "file", path: join(root, "e2e-artifacts/batch/session.json") });
			const serve = h.serve();
			expect(serve?.cmd).toEqual(["sh", "-c", "bun scripts/e2e/run-ios.ts --session"]);
			expect(serve?.opts.cwd).toBe(root);
			const want = {
				E2E_SESSION_FILE: "e2e-artifacts/batch/session.json",
				WARDEN_APP_PATH: "/c/S.app",
				WARDEN_APP_HASH: "SH",
			};
			expect(serve?.opts.env).toMatchObject(want);
			expect(serve?.opts.env.WARDEN_PORT_0).toBeDefined();
			expect(serve?.opts.env.WARDEN_UDIDS?.split(",").sort()).toEqual(["U1", "U2"]);
			const jobs = h.jobs();
			expect(jobs.map((j) => j.opts.env.WARDEN_JOB).sort()).toEqual(["qa-a", "qa-b", "qa-b"]);
			for (const j of jobs) {
				expect(j.opts.cwd).toBe(root);
				expect(j.opts.env).toMatchObject(want);
			}
			const a = jobs.find((j) => j.opts.env.WARDEN_JOB === "qa-a");
			expect(a?.cmd).toEqual([
				"bun",
				"scripts/e2e/run-ios.ts",
				"--attach",
				"qa-a",
				"--device",
				a?.opts.env.WARDEN_UDID ?? "",
			]);
			expect(new Set(jobs.map((j) => j.opts.env.WARDEN_UDID)).size).toBe(2);
			expect(c.db.listLeases()).toEqual([]);
		});

		test("precedence: only flags actually passed override the preset; -- overrides cmd; CLI paths use the invoking cwd", async () => {
			const c = setup([]);
			const configDir = c.cwd;
			writeConfig(configDir, {
				batches: {
					p: {
						platform: "ios",
						count: 2,
						retry: 3,
						label: "from-preset",
						jobs: ["a", "b"],
						logs: "preset-logs",
						serve: "s",
						serveReady: "file:ready",
						cmd: ["preset", "{job}"],
					},
				},
			});
			c.cwd = join(configDir, "sub");
			mkdirSync(c.cwd);
			c.argv = ["p", "--retry", "0", "--jobs", "bad", "--serve-ready", "file:cli-ready", "--", "cli", "{job}"];
			const h = harness({ exitCodes: { bad: 1 } });
			let labels: string[] = [];
			const spawn = h.deps.spawn;
			h.deps.spawn = (cmd, o) => {
				labels = c.db.listLeases().map((l) => `${l.label}`);
				return spawn(cmd, o);
			};
			expect(await createBatchCommand(h.deps).run(c)).toBe(1);
			expect(labels).toEqual(["from-preset"]);
			expect(h.jobs().map((j) => j.cmd)).toEqual([["cli", "bad"]]);
			expect(h.jobs()[0]?.opts.log).toBe(
				join(configDir, "preset-logs", `${h.jobs()[0]?.opts.env.WARDEN_WORKER}-0-bad.log`)
			);
			expect(h.jobs()[0]?.opts.cwd).toBe(configDir);
			expect(h.serve()?.opts.cwd).toBe(configDir);
			expect(h.probes[0]).toEqual({ kind: "file", path: join(c.cwd, "cli-ready") });
		});

		test("preset defaults (count, retry, cmd, label = name) survive commander's own defaults", async () => {
			const c = setup(["p"]);
			writeConfig(c.cwd, {
				batches: { p: { platform: "ios", count: 2, retry: 1, jobs: ["bad", "good"], cmd: ["x", "{job}"] } },
			});
			const h = harness({ exitCodes: { bad: 1 } });
			let labels: string[] = [];
			const spawn = h.deps.spawn;
			h.deps.spawn = (cmd, o) => {
				labels = c.db.listLeases().map((l) => `${l.label}`);
				return spawn(cmd, o);
			};
			expect(await createBatchCommand(h.deps).run(c)).toBe(1);
			expect(labels).toEqual(["p", "p"]);
			expect(h.jobs().filter((j) => j.cmd[1] === "bad")).toHaveLength(2);
			const summary = JSON.parse(
				h.files.get(join(c.env.WARDEN_HOME ?? "", "batches", "b1", "batch.json")) ?? "{}"
			) as BatchJson;
			expect(summary.devices).toHaveLength(2);
		});

		test("--jobs-from on the CLI replaces the preset's jobs source (stdin)", async () => {
			const c = setup(["p", "--jobs-from", "-"]);
			writeConfig(c.cwd, { batches: { p: { platform: "ios", jobsFrom: { command: "never" }, cmd: ["x"] } } });
			const sh = fakeSh(c, { stdout: "nope\n" });
			c.readStdin = async () => "s1\n";
			const h = harness();
			expect(await createBatchCommand(h.deps).run(c)).toBe(0);
			expect(sh).toEqual([]);
			expect(h.jobs().map((j) => j.opts.env.WARDEN_JOB)).toEqual(["s1"]);
		});

		test("{command} jobs source: nonzero exit or no output → exit 1 before anything is claimed", async () => {
			for (const [result, message] of [
				[{ exitCode: 3, stderr: "boom" }, "boom"],
				[{ stdout: "\n# only a comment\n" }, "no jobs"],
			] as const) {
				const c = setup(["p"]);
				writeConfig(c.cwd, { batches: { p: { platform: "ios", jobsFrom: { command: "list" }, cmd: ["x"] } } });
				fakeSh(c, result);
				const h = harness();
				expect(await createBatchCommand(h.deps).run(c)).toBe(1);
				expect(c.stderr.join("\n")).toContain(message);
				expect(h.spawned).toEqual([]);
				expect(c.db.listLeases()).toEqual([]);
				ctx?.cleanup();
			}
		});

		test("unknown preset or platform → clear error listing the presets; invalid config → its error", async () => {
			const c = setup(["nope", "--jobs", "a", "--", "x"]);
			writeConfig(c.cwd, {
				batches: { b: { platform: "ios", cmd: ["x"] }, a: { platform: "android", cmd: ["x"] } },
			});
			const h = harness();
			expect(await createBatchCommand(h.deps).run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain('unknown platform or preset "nope" (ios|android, presets: a, b)');
			expect(h.spawned).toEqual([]);
			ctx?.cleanup();

			const bare = setup(["nope", "--jobs", "a", "--", "x"]);
			expect(await createBatchCommand(harness().deps).run(bare)).toBe(1);
			expect(bare.stderr.join("\n")).toContain('unknown platform or preset "nope" (ios|android)');
			ctx?.cleanup();

			const broken = setup(["p", "--", "x"]);
			writeConfig(broken.cwd, { batches: { p: { platform: "ios" } } });
			expect(await createBatchCommand(harness().deps).run(broken)).toBe(1);
			expect(broken.stderr.join("\n")).toContain(`invalid ${CONFIG_FILE}: batches.p.cmd`);
		});

		test("fewer jobs than count → the claim is clamped to the job count", async () => {
			const c = setup(["p"]);
			writeConfig(c.cwd, {
				batches: { p: { platform: "ios", count: 5, max: 5, jobsFrom: { command: "list" }, cmd: ["x"] } },
			});
			fakeSh(c, { stdout: "only\n" });
			const h = harness();
			let leased = 0;
			const spawn = h.deps.spawn;
			h.deps.spawn = (cmd, o) => {
				leased = c.db.listLeases().filter((l) => l.resource.kind === "device").length;
				return spawn(cmd, o);
			};
			expect(await createBatchCommand(h.deps).run(c)).toBe(0);
			expect(leased).toBe(1);
			expect(c.stderr.join("\n")).toContain("1 job(s)");
		});

		test("app `installed` with nothing cached: WARDEN_APP_HASH set, WARDEN_APP_PATH unset", async () => {
			const c = setup(["p"]);
			writeConfig(c.cwd, {
				projects: [{ name: "s", root: ".", bundleId: { ios: "x" }, eas: { workflow: "w.yml", trigger: true } }],
				batches: {
					p: { project: "s", platform: "ios", label: "s-e2e", app: true, serve: "s", jobs: ["a"], cmd: ["x"] },
				},
			});
			const h = harness();
			h.deps.ensureApp = async () => ({
				success: true,
				data: { appPath: "", hash: "H", source: "installed", installed: true },
			});
			expect(await createBatchCommand(h.deps).run(c)).toBe(0);
			for (const proc of [h.serve(), h.jobs()[0]]) {
				expect(proc?.opts.env.WARDEN_APP_HASH).toBe("H");
				expect(proc?.opts.env.WARDEN_APP_PATH).toBeUndefined();
			}
		});

		test("preset without jobs needs --jobs/--jobs-from; a platform operand ignores the config", async () => {
			const c = setup(["p"]);
			writeConfig(c.cwd, { batches: { p: { platform: "ios", cmd: ["x"] } } });
			expect(await createBatchCommand(harness().deps).run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain("--jobs");
			ctx?.cleanup();

			const plain = setup(["ios", "--jobs", "a", "--", "x"]);
			writeConfig(plain.cwd, { batches: { p: { platform: "ios" } } });
			expect(await createBatchCommand(harness().deps).run(plain)).toBe(0);
		});
	});
});
