import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bunExec, type Exec } from "@delacour/warden-core/exec";
import { jsonl } from "../batch/results.testing";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { testContext } from "../testing";
import { type Harness, harness, type Spawned } from "./batch.testing";
import { createE2eCommand } from "./e2e";
import {
	bunTest,
	ctx,
	dir,
	reportOf,
	resuite,
	resultsPath,
	setCtx,
	setup,
	spec,
	useE2eFixture,
	waitFor,
	write,
} from "./e2e.testing";

useE2eFixture();

describe("warden e2e", () => {
	describe("isolate: device", () => {
		const specFiles = () => ["chats", "settings"].map((id) => join(dir, `specs/${id}.e2e.ts`));
		const shardOf = (job: Spawned | undefined) => job?.opts.env.WARDEN_JOB;

		test("one bun test process per device over its round-robin shard of the specs", async () => {
			await resuite({ isolate: "device", count: 2 });
			const c = setup(["--all"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			const jobs = h.jobs().sort((a, b) => (shardOf(a) ?? "").localeCompare(shardOf(b) ?? ""));
			expect(jobs.map(shardOf)).toEqual(["shard-0", "shard-1"]);
			expect(jobs[0]?.cmd).toEqual(bunTest(join(dir, "specs/chats.e2e.ts")));
			expect(jobs[1]?.cmd).toEqual(bunTest(join(dir, "specs/settings.e2e.ts")));
			expect(new Set(jobs.map((j) => j.opts.env.WARDEN_UDID)).size).toBe(2);
			for (const j of jobs) expect(j.opts.env.WARDEN_SPECS).toBeUndefined();
			expect(c.db.listLeases()).toEqual([]);
			const report = reportOf(h.files, c);
			expect(report).toMatchObject({ ok: true, isolate: "device" });
			expect(report.specs.map((f) => [f.id, f.verdict])).toEqual([
				["chats", "passed"],
				["settings", "passed"],
			]);
		});

		test("one device runs every spec in one process; shards never outnumber specs", async () => {
			await resuite({ isolate: "device", count: 1 });
			const one = harness();
			expect(await createE2eCommand(one.deps).run(setup(["--all"]))).toBe(0);
			expect(one.jobs().map((j) => j.cmd)).toEqual([bunTest(...specFiles())]);
			expect(one.jobs().map(shardOf)).toEqual(["shard-0"]);

			await resuite({ isolate: "device", count: 5 });
			const many = harness();
			expect(await createE2eCommand(many.deps).run(setup(["--all"]))).toBe(0);
			expect(many.jobs()).toHaveLength(2);
		});

		test("a failing shard fails only its specs", async () => {
			await resuite({ isolate: "device", count: 2 });
			const c = setup(["--all"]);
			const h = harness({ exitCodes: { "shard-1": 1 } });
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(reportOf(h.files, c).specs.map((f) => [f.id, f.verdict])).toEqual([
				["chats", "passed"],
				["settings", "failed"],
			]);
		});

		test("live spec progress: the grid lists a device's shard and marks each spec as its results.jsonl reports it", async () => {
			await resuite({ isolate: "device" });
			const c = setup(["--all"]);
			const h = harness({ manual: true, isTTY: true });
			const running = createE2eCommand(h.deps).run(c);
			await waitFor(() => h.jobs().length > 0);
			const job = h.jobs()[0];
			h.files.set(
				resultsPath(job?.opts.env ?? {}),
				jsonl(spec("chats", "open", "passed"), spec("settings", "toggle", "failed"))
			);
			job?.finish(1);
			expect(await running).toBe(0);
			const screen = h.terminal.join("");
			expect(screen).toContain("· chats  · settings");
			expect(screen).toContain("✓ chats  ✗ settings");
			expect(screen).toContain("2/2");
		});

		test("each device's row lists only its own shard", async () => {
			await resuite({ isolate: "device", count: 2 });
			const c = setup(["--all"]);
			const h = harness({ isTTY: true });
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			const frame = h.terminal.join("").split("\u001b[0J").at(-1) ?? "";
			const lines = frame.split("\n").filter((l) => l.includes("chats") || l.includes("settings"));
			expect(lines).toHaveLength(2);
			for (const line of lines) expect(line.includes("chats") && line.includes("settings")).toBe(false);
		});

		test("the process's exit code decides when it wrote no results, with a warning", async () => {
			await resuite({ isolate: "device" });
			const c = setup(["--all"]);
			const h = harness({ exitCodeFor: () => 1 });
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(reportOf(h.files, c).specs.map((f) => f.verdict)).toEqual(["failed", "failed"]);
			expect(c.stderr.join("\n")).toContain("shard-0: no results.jsonl — verdict from exit code 1");
		});

		test("per-spec verdicts from results.jsonl: a failing test fails its spec only, the exit code blames the rest", async () => {
			await resuite({ isolate: "device" });
			const c = setup(["--all"]);
			const h: Harness = harness({
				exitCodeFor: (env) => {
					h.files.set(
						resultsPath(env),
						jsonl(
							spec("chats", "open", "passed"),
							spec("settings", "toggle", "failed", { error: { message: "no such element" } })
						)
					);
					return 1;
				},
			});
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			const report = reportOf(h.files, c);
			expect(report.specs.map((f) => [f.id, f.verdict])).toEqual([
				["chats", "passed"],
				["settings", "failed"],
			]);
			expect(report.specs[1]?.tests?.[0]).toMatchObject({
				title: ["toggle"],
				status: "failed",
				error: "no such element",
			});
			expect(c.stderr.join("\n")).toContain("settings failed (optional)");
		});

		test("a failed test with the runner's failure.png: no batch screenshot, the report points at the runner's", async () => {
			await resuite({ isolate: "device" });
			const c = setup(["--all"]);
			const h: Harness = harness({
				exitCodeFor: (env) => {
					h.files.set(
						resultsPath(env),
						jsonl(
							spec("chats", "open", "passed"),
							spec("settings", "toggle", "failed", {
								artifacts: { dir: "/art/settings-1", files: ["failure.png", "screen-at-failure.txt"] },
							})
						)
					);
					return 1;
				},
			});
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(h.shots).toEqual([]);
			const report = reportOf(h.files, c);
			expect(report.specs.find((f) => f.id === "settings")?.screenshot).toBe("/art/settings-1/failure.png");
			expect(report.specs.find((f) => f.id === "chats")).not.toHaveProperty("screenshot");
		});

		test("a failed test without failure.png still gets the batch screenshot", async () => {
			await resuite({ isolate: "device" });
			const c = setup(["--all"]);
			const h: Harness = harness({
				exitCodeFor: (env) => {
					h.files.set(resultsPath(env), jsonl(spec("chats", "open", "passed"), spec("settings", "toggle", "failed")));
					return 1;
				},
			});
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(h.shots).toHaveLength(1);
		});
	});

	describe("results.jsonl", () => {
		/** a harness whose jobs write `text` (or `build(env)`) as their results and exit with `exit` */
		const writing = (build: (env: Record<string, string | undefined>) => string, exit = 0): Harness => {
			const h: Harness = harness({
				exitCodeFor: (env) => {
					if (env.WARDEN_E2E_OUT) h.files.set(resultsPath(env), build(env));
					return exit;
				},
			});
			return h;
		};

		test("e2e-report.json carries each spec's tests (title path, status, duration, error, artifacts) and headless", async () => {
			const h = writing(
				() =>
					jsonl(
						spec("chats", "opens", "passed", { title: ["list", "opens"], durationMs: 2100 }),
						spec("chats", "sends", "failed", {
							error: { message: "LOCATOR_NOT_FOUND\nid=send" },
							artifacts: { dir: "/o/chats/sends-a1b2c3", files: ["failure.png"] },
						})
					),
				1
			);
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			const report = reportOf(h.files, c);
			expect(report.headless).toBe(false);
			expect(report.specs[0]?.verdict).toBe("failed");
			expect(report.specs[0]?.tests).toEqual([
				{ title: ["list", "opens"], status: "passed", durationMs: 2100 },
				{
					title: ["sends"],
					status: "failed",
					durationMs: 1250,
					error: "LOCATOR_NOT_FOUND\nid=send",
					artifacts: "/o/chats/sends-a1b2c3",
				},
			]);
			const text = c.stderr.join("\n");
			expect(text).toContain("✗ sends — LOCATOR_NOT_FOUND — artifacts /o/chats/sends-a1b2c3");
			expect(text).not.toContain("✗ list");
		});

		test("passed: tests recorded, no warning", async () => {
			const h = writing(() => jsonl(spec("chats", "opens")));
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(reportOf(h.files, c).specs[0]?.tests).toHaveLength(1);
			expect(c.stderr.join("\n")).not.toContain("no results.jsonl");
		});

		test("a timed-out test fails the spec even when the process exited 0", async () => {
			const h = writing(() => jsonl(spec("chats", "slow", "timed-out")));
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(reportOf(h.files, c).specs[0]).toMatchObject({ verdict: "failed", tests: [{ status: "timed-out" }] });
		});

		test("no results file: the exit code decides, with a warning", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const pass = harness();
			expect(await createE2eCommand(pass.deps).run(c)).toBe(0);
			expect(c.stderr.join("\n")).toContain("chats: no results.jsonl — verdict from exit code 0");
			expect(reportOf(pass.files, c).specs[0]).not.toHaveProperty("tests");
			const fail = harness({ exitCodes: { chats: 1 } });
			expect(await createE2eCommand(fail.deps).run(c)).toBe(1);
		});

		test("an unparseable results file counts as missing; a truncated last line is skipped", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const junk = writing(() => "this is not json\n{oops\n", 1);
			expect(await createE2eCommand(junk.deps).run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain("chats: no results.jsonl — verdict from exit code 1");

			const cut = writing(() => `${jsonl(spec("chats", "opens"))}{"file":"${join(dir, "specs/chats.e2e.ts")}","ti`);
			expect(await createE2eCommand(cut.deps).run(c)).toBe(0);
			expect(reportOf(cut.files, c).specs[0]?.tests).toHaveLength(1);
		});

		test("test.only left in a spec fails the run under CI, even when everything passed; locally it does not", async () => {
			const build = () => jsonl(spec("chats", "opens", "passed", { only: true }));
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			c.env = { ...c.env, CI: "true" };
			const h = writing(build);
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain(`test.only left in ${join(dir, "specs/chats.e2e.ts")}`);
			expect(reportOf(h.files, c)).toMatchObject({ ok: false, only: [join(dir, "specs/chats.e2e.ts")] });
			expect(reportOf(h.files, c).specs[0]?.verdict).toBe("passed");

			c.env = { ...c.env, CI: "" };
			expect(await createE2eCommand(writing(build).deps).run(c)).toBe(0);
		});

		test("--no-tui: a line per finished test as results arrive, then a line per finished spec", async () => {
			await resuite({ isolate: "device" });
			const c = setup(["--all", "--no-tui"]);
			const h = harness({ manual: true });
			const running = createE2eCommand(h.deps).run(c);
			await waitFor(() => h.jobs().length > 0);
			const job = h.jobs()[0];
			h.files.set(
				resultsPath(job?.opts.env ?? {}),
				jsonl(spec("chats", "opens", "passed", { title: ["list", "opens"] }), spec("settings", "toggle", "failed"))
			);
			job?.finish(1);
			await running;
			const text = c.stderr.join("\n");
			expect(text).toContain("✓ chats › list › opens (1.25s)");
			expect(text).toContain("✗ settings › toggle (1.25s)");
			expect(text).toContain("warden-iphone-17-1 ✓ chats");
		});

		test("per-spec mode prints the same test lines", async () => {
			const h = writing(() => jsonl(spec("chats", "opens")));
			const c = setup(["--files", "src/chat/lazy.tsx", "--no-tui"]);
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(c.stderr.join("\n")).toContain("✓ chats › opens (1.25s)");
		});
	});

	describe("device legs", () => {
		const devices = [
			{ profile: "iphone-17", count: 1 },
			{ profile: "ipad", count: 1, env: { E2E_LAYOUT: "regular" }, default: false },
		];
		const sims = () => [wardenSim(1, "Booted"), { udid: "P1", name: "warden-ipad-1", state: "Booted" as const }];
		const legSetup = (argv: string[]) => {
			const sim = fakeSimctl(sims(), []);
			const exec: Exec = (cmd, opts) => (cmd[0] === "git" ? bunExec(cmd, opts) : sim(cmd, opts));
			setCtx(testContext(argv, { exec }));
			ctx.env = { ...ctx.env, ...OWNER_ENV };
			ctx.cwd = dir;
			return ctx;
		};

		test("by default only the default legs run", async () => {
			await resuite({ devices });
			const c = legSetup(["--files", "src/chat/lazy.tsx"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(h.jobs().map((j) => [j.cmd, j.opts.env.WARDEN_UDID, j.opts.env.WARDEN_LEG])).toEqual([
				[bunTest(join(dir, "specs/chats.e2e.ts")), "U1", "iphone-17"],
			]);
			expect(reportOf(h.files, c).specs.map((f) => [f.id, f.leg, f.verdict])).toEqual([
				["chats", "iphone-17", "passed"],
			]);
		});

		test("--devices all: every leg claims its own pool and runs every spec, with its env and only its devices", async () => {
			await resuite({ devices });
			const c = legSetup(["--files", "src/chat/lazy.tsx", "--devices", "all"]);
			const h = harness({ exitCodeFor: (env) => (env.WARDEN_LEG === "ipad" ? 1 : 0) });
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			const byLeg = new Map(h.jobs().map((j) => [j.opts.env.WARDEN_LEG, j]));
			expect([...byLeg.keys()].sort()).toEqual(["ipad", "iphone-17"]);
			expect(byLeg.get("ipad")?.cmd).toEqual(bunTest(join(dir, "specs/chats.e2e.ts")));
			expect(byLeg.get("ipad")?.opts.env).toMatchObject({
				WARDEN_UDID: "P1",
				WARDEN_UDIDS: "P1",
				WARDEN_UDID_0: "P1",
				WARDEN_JOB: "chats",
				E2E_LAYOUT: "regular",
			});
			expect(byLeg.get("iphone-17")?.opts.env).toMatchObject({ WARDEN_UDID: "U1", WARDEN_UDIDS: "U1" });
			expect(byLeg.get("iphone-17")?.opts.env.E2E_LAYOUT).toBeUndefined();
			const report = reportOf(h.files, c);
			expect(report.ok).toBe(false);
			expect(report.specs.map((f) => [f.id, f.leg, f.verdict])).toEqual([
				["chats", "iphone-17", "passed"],
				["chats", "ipad", "failed"],
			]);
			expect(c.stderr.join("\n")).toContain("chats [ipad] failed");
			expect(c.db.listLeases()).toEqual([]);
		});

		test("--devices <profile> picks legs by name; an unknown one is an error", async () => {
			await resuite({ devices });
			const c = legSetup(["--files", "src/chat/lazy.tsx", "--devices", "ipad"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(h.jobs().map((j) => j.opts.env.WARDEN_LEG)).toEqual(["ipad"]);
			c.argv = ["--files", "src/chat/lazy.tsx", "--devices", "watch"];
			expect(await createE2eCommand(harness().deps).run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain('--devices: no leg "watch" (iphone-17, ipad)');
		});
	});

	describe("warmDrivers", () => {
		const jobEnv = (h: Harness) => h.jobs().map((j) => j.opts.env.WARDEN_SIMD_SOCKET);

		test("every leased iOS device is warmed before the first job; its jobs get WARDEN_SIMD_SOCKET", async () => {
			write("src/chat/lazy.tsx", "export const x = 2;\n");
			write("src/settings/form.tsx", "export const y = 2;\n");
			const c = setup(["--count", "2"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(h.warmed.sort()).toEqual(["U1", "U2"]);
			const firstJob = h.events.findIndex((e) => e.startsWith("job:"));
			expect(h.events.lastIndexOf("warm:U1")).toBeLessThan(firstJob);
			expect(h.events.lastIndexOf("warm:U2")).toBeLessThan(firstJob);
			for (const job of h.jobs()) {
				expect(job.opts.env.WARDEN_SIMD_SOCKET).toBe(`/tmp/warden-simd-${job.opts.env.WARDEN_UDID}.sock`);
			}
			expect(h.files.get(join(c.env.WARDEN_HOME ?? "", "batches", "b1", "logs", "warm-0.log"))).toContain(
				"snapshot ok"
			);
			expect(h.warmClosed.sort()).toEqual(["U1", "U2"]);
		});

		test("the warm-up starts when a device is leased: before its app install ends, before setup", async () => {
			await resuite(
				{ project: "app", app: true, setup: "prep {udid}" },
				{ projects: [{ name: "app", root: "packages/ui", bundleId: { ios: "com.x" } }] }
			);
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness();
			const install = Promise.withResolvers<void>();
			h.deps.ensureApp = async () => {
				h.events.push("app:start");
				await install.promise;
				h.events.push("app:end");
				return { success: true, data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true } };
			};
			const run = createE2eCommand(h.deps).run(c);
			await waitFor(() => h.warmed.length === 1);
			expect(h.events).toContain("app:start");
			expect(h.events).not.toContain("app:end");
			expect(h.warmed).toEqual(["U1"]);
			install.resolve();
			expect(await run).toBe(0);
			expect(h.events.indexOf("warm:U1")).toBeLessThan(h.events.indexOf("app:end"));
			expect(h.events.indexOf("warm:U1")).toBeLessThan(h.events.findIndex((e) => e.startsWith("setup:")));
			expect(jobEnv(h)).toEqual(["/tmp/warden-simd-U1.sock"]);
		});

		test("a device whose setup fails: its warmed helper is closed before the jobs, and only the others get a socket", async () => {
			await resuite({ setup: "prep {udid}" });
			write("src/chat/lazy.tsx", "export const x = 2;\n");
			write("src/settings/form.tsx", "export const y = 2;\n");
			const c = setup(["--count", "2"]);
			let bad: string | undefined;
			const h = harness({
				exitCodeFor: (env) => {
					if (env.WARDEN_JOB !== undefined) return 0;
					bad ??= env.WARDEN_UDID;
					return env.WARDEN_UDID === bad ? 3 : 0;
				},
			});
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			const firstJob = h.events.findIndex((e) => e.startsWith("job:"));
			expect(h.events.indexOf(`warm-close:${bad}`)).toBeGreaterThan(-1);
			expect(h.events.indexOf(`warm-close:${bad}`)).toBeLessThan(firstJob);
			expect(new Set(jobEnv(h)).size).toBe(1);
			expect(jobEnv(h).every((socket) => socket !== undefined && !socket.includes(bad ?? "?"))).toBe(true);
			expect([...h.warmClosed].sort()).toEqual(["U1", "U2"]);
		});

		test("setup failing everywhere: the run fails and every warmed helper is closed", async () => {
			await resuite({ setup: "prep {udid}" });
			write("src/chat/lazy.tsx", "export const x = 2;\n");
			write("src/settings/form.tsx", "export const y = 2;\n");
			const c = setup(["--count", "2"]);
			const h = harness({ exitCodeFor: () => 1 });
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect([...h.warmed].sort()).toEqual(["U1", "U2"]);
			expect([...h.warmClosed].sort()).toEqual(["U1", "U2"]);
		});

		test("a run that fails after the claim (Metro never builds) still closes the warmed helpers", async () => {
			await resuite(
				{ project: "app", metro: {} },
				{ projects: [{ name: "app", root: "packages/ui", bundleId: { ios: "com.x" } }] }
			);
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness({ prewarm: "fail" });
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(h.jobs()).toEqual([]);
			expect(h.warmClosed).toEqual(["U1"]);
		});

		test("legs: each device's warm log and socket follow its worker number, whatever order the legs landed in", async () => {
			await resuite({
				devices: [
					{ profile: "iphone-17", count: 1 },
					{ profile: "ipad", count: 1, default: false },
				],
			});
			const sims = [wardenSim(1, "Booted"), { udid: "P1", name: "warden-ipad-1", state: "Booted" as const }];
			const sim = fakeSimctl(sims);
			const exec: Exec = (cmd, opts) => (cmd[0] === "git" ? bunExec(cmd, opts) : sim(cmd, opts));
			setCtx(testContext(["--files", "src/chat/lazy.tsx", "--devices", "all"], { exec }));
			ctx.env = { ...ctx.env, ...OWNER_ENV };
			ctx.cwd = dir;
			const h = harness();
			expect(await createE2eCommand(h.deps).run(ctx)).toBe(0);
			const log = (worker: number) =>
				h.files.get(join(ctx?.env.WARDEN_HOME ?? "", "batches", "b1", "logs", `warm-${worker}.log`)) ?? "";
			expect(log(0)).toContain("warming U1");
			expect(log(1)).toContain("warming P1");
			expect(Object.fromEntries(h.jobs().map((j) => [j.opts.env.WARDEN_UDID, j.opts.env.WARDEN_SIMD_SOCKET]))).toEqual({
				U1: "/tmp/warden-simd-U1.sock",
				P1: "/tmp/warden-simd-P1.sock",
			});
		});

		const twoLegs = (...extra: string[]) => {
			const sims = [wardenSim(1, "Booted"), { udid: "P1", name: "warden-ipad-1", state: "Booted" as const }];
			const sim = fakeSimctl(sims);
			const exec: Exec = (cmd, opts) => (cmd[0] === "git" ? bunExec(cmd, opts) : sim(cmd, opts));
			setCtx(testContext(["--files", "src/chat/lazy.tsx", "--devices", "all", ...extra], { exec }));
			ctx.env = { ...ctx.env, ...OWNER_ENV };
			ctx.cwd = dir;
			return ctx;
		};
		const legs = [
			{ profile: "iphone-17", count: 1 },
			{ profile: "ipad", count: 1, default: false },
		];

		test("legs: a device whose warm-up hangs holds only its own first job, not the other leg's (12-3)", async () => {
			await resuite({ devices: legs });
			const c = twoLegs();
			const h = harness();
			const base = h.deps.warmConnect(c);
			const hung = Promise.withResolvers<void>();
			h.deps.warmConnect = () => async (udid) => {
				if (udid === "P1") await hung.promise;
				return base(udid);
			};
			const run = createE2eCommand(h.deps).run(c);
			await waitFor(() => h.jobs().length === 1);
			expect(h.jobs().map((j) => [j.opts.env.WARDEN_UDID, j.opts.env.WARDEN_SIMD_SOCKET])).toEqual([
				["U1", "/tmp/warden-simd-U1.sock"],
			]);
			// P1's warm-up times out: its job runs cold
			for (const timer of h.timers.filter((t) => t.ms === 120_000 && !t.cancelled)) timer.fire();
			expect(await run).toBe(0);
			const p1 = h.jobs().find((j) => j.opts.env.WARDEN_UDID === "P1");
			expect(p1?.opts.env.WARDEN_SIMD_SOCKET).toBeUndefined();
			expect(c.stderr.join("\n")).toContain("warm P1: timed out after 120s");
			hung.resolve();
		});

		test("legs: a leg still slimming does not hold the other leg's first job (12-3)", async () => {
			await resuite({ devices: legs, slim: true });
			const c = twoLegs();
			const h = harness();
			const slow = Promise.withResolvers<void>();
			const slim = h.deps.slim;
			h.deps.slim = async (udid) => {
				if (udid === "P1") await slow.promise;
				return slim(udid);
			};
			const run = createE2eCommand(h.deps).run(c);
			await waitFor(() => h.jobs().length === 1);
			expect(h.jobs().map((j) => j.opts.env.WARDEN_UDID)).toEqual(["U1"]);
			slow.resolve();
			expect(await run).toBe(0);
			expect(
				h
					.jobs()
					.map((j) => j.opts.env.WARDEN_UDID)
					.sort()
			).toEqual(["P1", "U1"]);
		});

		test("legs: one leg's install fails while the other is slimming → nothing is released until the slim is done (batch-pipeline R3)", async () => {
			await resuite({ devices: legs, slim: true, app: { installMode: "clean" } });
			const c = twoLegs();
			const h = harness();
			const slow = Promise.withResolvers<void>();
			const slim = h.deps.slim;
			let slimming = false;
			h.deps.slim = async (udid) => {
				if (udid !== "U1") return slim(udid);
				slimming = true;
				await slow.promise;
				return slim(udid);
			};
			let failed = false;
			h.deps.ensureApp = async (_ctx, _owner, _platform, deviceId) => {
				if (deviceId !== "P1")
					return { success: true, data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true } };
				failed = true;
				return { success: false, error: "no build" };
			};
			const run = createE2eCommand(h.deps).run(c);
			await waitFor(() => slimming && failed);
			await Bun.sleep(20);
			// U1 is still being slimmed: its lease must outlive that, or another agent could lease it meanwhile
			expect(c.db.listLeases().map((l) => (l.resource.kind === "device" ? l.resource.id : "port"))).toContain("U1");
			slow.resolve();
			expect(await run).toBe(1);
			expect(c.db.listLeases()).toEqual([]);
			expect(h.jobs()).toEqual([]);
		});

		test("legs: a pool whose preparation throws fails only itself; the other pool's job runs on to its end (batch-pipeline R4)", async () => {
			const projects = { projects: [{ name: "app", root: "packages/ui", bundleId: { ios: "com.x" } }] };
			await resuite({ devices: legs, slim: true, project: "app", metro: {} }, projects);
			const sim = fakeSimctl([wardenSim(1, "Booted"), { udid: "P1", name: "warden-ipad-1", state: "Booted" as const }]);
			const exec: Exec = async (cmd, opts) => {
				if (cmd[0] === "git") return bunExec(cmd, opts);
				if (cmd[0] === "xcrun" && cmd[2] === "launch" && cmd.includes("P1")) throw new Error("launch blew up");
				return sim(cmd, opts);
			};
			const c = testContext(["--files", "src/chat/lazy.tsx", "--devices", "all"], { exec });
			setCtx(c);
			c.env = { ...c.env, ...OWNER_ENV };
			c.cwd = dir;
			const h = harness({ manual: true });
			const slow = Promise.withResolvers<void>();
			const slim = h.deps.slim;
			h.deps.slim = async (udid) => {
				if (udid === "P1") await slow.promise;
				return slim(udid);
			};
			let settled = false;
			const run = createE2eCommand(h.deps)
				.run(c)
				.finally(() => {
					settled = true;
				});
			await waitFor(() => h.jobs().length === 1);
			slow.resolve();
			await Bun.sleep(20);
			// U1's job is still running: the run waits for it, and its device stays leased under it
			expect(settled).toBe(false);
			expect(h.jobs()[0]?.kills).toEqual([]);
			expect(c.db.listLeases().some((l) => l.resource.kind === "device" && l.resource.id === "U1")).toBe(true);
			h.jobs()[0]?.finish(0);
			expect(await run).toBe(1);
			expect(h.jobs()).toHaveLength(1);
			expect(c.stderr.join("\n")).toContain("launch blew up");
			expect(c.db.listLeases()).toEqual([]);
		});

		/** Two legs, isolate device, `late`'s leg late (still slimming when the grid starts); every shard passes chats, except `failing`'s. */
		const lateLeg = async (argv: string[], isTTY: boolean, late = "P1", failing?: string) => {
			await resuite({ devices: legs, slim: true, isolate: "device" });
			const c = twoLegs(...argv);
			const h: Harness = harness({
				isTTY,
				exitCodeFor: (env) => {
					const status = env.WARDEN_UDID === failing ? "failed" : "passed";
					if (env.WARDEN_E2E_OUT) h.files.set(resultsPath(env), jsonl(spec("chats", "opens", status)));
					return 0;
				},
			});
			const slow = Promise.withResolvers<void>();
			const slim = h.deps.slim;
			h.deps.slim = async (udid) => {
				if (udid === late) await slow.promise;
				return slim(udid);
			};
			if (failing) c.ui.color.level = 1;
			const run = createE2eCommand(h.deps).run(c);
			await waitFor(() => h.jobs().length === 1);
			slow.resolve();
			expect(await run).toBe(failing ? 1 : 0);
			return { c, h };
		};

		test("legs, isolate device: a late leg's specs show in the --no-tui lines (batch-pipeline R1)", async () => {
			const { c } = await lateLeg(["--no-tui"], false);
			const text = c.stderr.join("\n");
			expect(text).toContain("warden-iphone-17-1 ✓ chats");
			expect(text).toContain("warden-ipad-1 ✓ chats");
		});

		test("legs, isolate device: a late leg's specs count in the grid header's totals (batch-pipeline R1)", async () => {
			const { h } = await lateLeg([], true);
			const screen = Bun.stripANSI(h.terminal.join(""));
			expect(screen).toContain("  2/2  ");
			expect(screen).not.toContain("  1/1  ");
		});

		test("legs, isolate device: leg 0 late and failing → the header's cells stay in worker order (batch-pipeline-S3)", async () => {
			const { h } = await lateLeg([], true, "U1", "U1");
			const header = Bun.stripANSI(h.terminal.join("").split("\r").at(-1)?.split("\n")[0] ?? "");
			// worker 0 (U1, the late leg) failed: its cell leads the bar
			expect(header).toContain("×█");
		});

		test("a headless run hides the simulator windows first", async () => {
			if (process.platform !== "darwin") return;
			await resuite({ headless: true });
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness();
			const base = c.exec;
			c.exec = async (cmd, opts) => {
				if (cmd[0] !== "osascript") return base(cmd, opts);
				if ((cmd[4] ?? "").includes("AXCloseButton")) h.events.push("close");
				const windows = [{ title: "warden-iphone-17-1 – iOS 26.5", width: 400, height: 800 }];
				return {
					exitCode: 0,
					stdout: JSON.stringify({ screen: { x: 0, y: 0, width: 900, height: 900 }, windows }),
					stderr: "",
				};
			};
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			const close = h.events.lastIndexOf("close");
			expect(close).toBeGreaterThanOrEqual(0);
			expect(close).toBeLessThan(h.events.indexOf("warm:U1"));
			expect(h.events.indexOf("warm:U1")).toBeLessThan(h.events.findIndex((e) => e.startsWith("job:")));
		});

		test("a failed warm-up only warns: jobs still run, with no socket", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness({ warm: "fail" });
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(c.stderr.join("\n")).toContain("warm U1: helper did not start");
			expect(jobEnv(h)).toEqual([undefined]);
			expect(h.jobs()).toHaveLength(1);
		});

		test("a helper that cannot snapshot warns, is stopped, and its jobs get no socket", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness({ warm: "snapshot-fail" });
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(c.stderr.join("\n")).toContain("snapshot failed: AX denied");
			expect(jobEnv(h)).toEqual([undefined]);
			// stopped, not only disconnected: no resident helper beside the jobs' own (20-1)
			expect(h.warmStopped).toEqual(["U1"]);
			expect(h.events.indexOf("warm-stop:U1")).toBeLessThan(h.events.findIndex((e) => e.startsWith("job:")));
			expect(h.warmClosed).toEqual([]);
		});

		test("suite warmDrivers: false skips it", async () => {
			await resuite({ warmDrivers: false });
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(h.warmed).toEqual([]);
			expect(jobEnv(h)).toEqual([undefined]);
		});

		test("--no-warm skips it", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx", "--no-warm"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(h.warmed).toEqual([]);
		});

		test("--no-warm with a helper still running for the device: its jobs get that socket (20-1)", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx", "--no-warm"]);
			const h = harness();
			const asked: string[] = [];
			h.deps.residentSocket = () => async (udid) => {
				asked.push(udid);
				return `/home/simd/${udid}.sock`;
			};
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(h.warmed).toEqual([]);
			expect(asked).toEqual(["U1"]);
			expect(jobEnv(h)).toEqual(["/home/simd/U1.sock"]);
		});

		test("--no-warm with no helper running: no socket", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx", "--no-warm"]);
			const h = harness();
			h.deps.residentSocket = () => async () => undefined;
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(jobEnv(h)).toEqual([undefined]);
		});

		test("suite warmDrivers: false also uses a running helper's socket", async () => {
			await resuite({ warmDrivers: false });
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness();
			h.deps.residentSocket = () => async (udid) => `/home/simd/${udid}.sock`;
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(jobEnv(h)).toEqual(["/home/simd/U1.sock"]);
		});

		test("with the warm-up on, a running helper is not looked up separately", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness({ warm: "snapshot-fail" });
			const asked: string[] = [];
			h.deps.residentSocket = () => async (udid) => {
				asked.push(udid);
				return `/home/simd/${udid}.sock`;
			};
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(asked).toEqual([]);
			expect(jobEnv(h)).toEqual([undefined]);
		});

		test("device isolation warms once per device, before its shard starts", async () => {
			await resuite({ isolate: "device" });
			const c = setup(["--all"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(h.warmed).toEqual(["U1"]);
			expect(jobEnv(h)).toEqual(["/tmp/warden-simd-U1.sock"]);
		});
	});
});
