import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSuiteRepo } from "@delacour/warden-core/affected/fixture.testing";
import { bunExec, type Exec } from "@delacour/warden-core/exec";
import type { TestResult } from "@delacour/warden-e2e/runner/results";
import { jsonl, result } from "../batch/results.testing";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { scriptedUi, type TestContext, testContext } from "../testing";
import { type Harness, harness, type Spawned } from "./batch.testing";
import { createE2eCommand, type E2eReport } from "./e2e";

let dir: string;
let write: (path: string, text: string) => void;
let ctx: TestContext | undefined;

/** the suites below were written for one spec process per flow; the device-isolation tests opt in */
const FLOW_ISOLATION = { isolate: "flow" };

beforeEach(async () => {
	({ dir, write } = await makeSuiteRepo(FLOW_ISOLATION));
});
afterEach(() => {
	ctx?.cleanup();
	ctx = undefined;
	rmSync(dir, { recursive: true, force: true });
});

/** Swap the fixture for one whose suite has `overrides` (one spec process per flow unless they say otherwise). */
async function resuite(overrides: Record<string, unknown>, config: Record<string, unknown> = {}): Promise<void> {
	rmSync(dir, { recursive: true, force: true });
	({ dir, write } = await makeSuiteRepo({ ...FLOW_ISOLATION, ...overrides }, config));
}

/** Swap the fixture for a suite that says nothing about `isolate`, plus `overrides`. */
async function resuiteDefault(overrides: Record<string, unknown> = {}): Promise<void> {
	rmSync(dir, { recursive: true, force: true });
	({ dir, write } = await makeSuiteRepo(overrides));
}

function setup(argv: string[], calls: string[][] = []): TestContext {
	const sim = fakeSimctl([wardenSim(1, "Booted"), wardenSim(2, "Booted")], calls);
	const exec: Exec = (cmd, opts) => (cmd[0] === "git" ? bunExec(cmd, opts) : sim(cmd, opts));
	ctx = testContext(argv, { exec });
	ctx.env = { ...ctx.env, ...OWNER_ENV };
	ctx.cwd = dir;
	return ctx;
}

async function waitFor(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 500 && !cond(); i++) await Bun.sleep(1);
}

const BUN = "/usr/bin/bun";
const PRELOAD = "/proj/node_modules/@delacour/warden-e2e/src/preload.ts";

/** `bun test` argv of the default spec timeouts (2m + 30s) over these files */
const bunTest = (...files: string[]) => [BUN, "test", "--preload", PRELOAD, "--timeout", "150000", ...files];

/** Where a spawned job's spec process writes `results.jsonl`. */
const resultsPath = (env: Record<string, string | undefined>) => join(env.WARDEN_E2E_OUT ?? "", "results.jsonl");

/** `result()` for a spec file of the suite's flows dir. */
const spec = (flow: string, title: string, status: TestResult["status"] = "passed", extra: Partial<TestResult> = {}) =>
	result(join(dir, `flows/${flow}.e2e.ts`), title, status, extra);

const reportOf = (files: Map<string, string>, c: TestContext): E2eReport =>
	JSON.parse(files.get(join(c.env.WARDEN_HOME ?? "", "batches", "b1", "e2e-report.json")) ?? "{}");

describe("warden e2e", () => {
	test("runs the affected flows with bun test, in the config dir; report + gate pass", async () => {
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		write("src/settings/form.tsx", "export const y = 2;\n");
		const c = setup(["--count", "2"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		const jobs = h.jobs();
		expect(jobs.map((j) => j.opts.env.WARDEN_JOB).sort()).toEqual(["chats", "settings"]);
		const chats = jobs.find((j) => j.opts.env.WARDEN_JOB === "chats");
		expect(chats?.cmd).toEqual(bunTest(join(dir, "flows/chats.e2e.ts")));
		expect(chats?.opts.cwd).toBe(dir);
		const report = reportOf(h.files, c);
		expect(report).toMatchObject({ suite: "mobile", platform: "ios", base: "main", ok: true });
		expect(report.flows.map((f) => [f.id, f.verdict, f.required])).toEqual([
			["chats", "passed", true],
			["settings", "passed", false],
		]);
		expect(c.db.listLeases()).toEqual([]);
		expect(c.stderr.join("\n")).toContain("2/2 flow(s) passed — gate passed");
	});

	test("an optional flow failing doesn't fail the gate; a required one does", async () => {
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		write("src/settings/form.tsx", "export const y = 2;\n");
		const c = setup([]);
		const optional = harness({ exitCodes: { settings: 1 } });
		expect(await createE2eCommand(optional.deps).run(c)).toBe(0);
		expect(c.stderr.join("\n")).toContain("settings failed (optional)");

		const required = harness({ exitCodes: { chats: 1 } });
		expect(await createE2eCommand(required.deps).run(c)).toBe(1);
		expect(reportOf(required.files, c).ok).toBe(false);
		expect(c.stderr.join("\n")).toContain("gate failed");
	});

	test("a failed flow's report entry carries its failure screenshot; passed flows carry none", async () => {
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		write("src/settings/form.tsx", "export const y = 2;\n");
		const c = setup(["--count", "2"]);
		const h = harness({ exitCodes: { chats: 1 } });
		expect(await createE2eCommand(h.deps).run(c)).toBe(1);
		const report = reportOf(h.files, c);
		const chats = report.flows.find((f) => f.id === "chats");
		const chatsRun = h.jobs().find((j) => j.opts.env.WARDEN_JOB === "chats");
		expect(chats?.screenshot).toBe(chatsRun?.opts.log.replace(/\.log$/, ".png"));
		expect(h.shots).toHaveLength(1);
		expect(report.flows.find((f) => f.id === "settings")).not.toHaveProperty("screenshot");
	});

	test("a failed flow is summarised with its device, log and screenshot", async () => {
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		write("src/settings/form.tsx", "export const y = 2;\n");
		const c = setup(["--count", "2"]);
		const h = harness({ exitCodes: { chats: 1 } });
		expect(await createE2eCommand(h.deps).run(c)).toBe(1);
		const run = h.jobs().find((j) => j.opts.env.WARDEN_JOB === "chats");
		const chats = reportOf(h.files, c).flows.find((f) => f.id === "chats");
		expect(chats?.device?.udid).toBe(run?.opts.env.WARDEN_UDID);
		expect(chats?.device?.name).toMatch(/^warden-iphone-17-/);
		expect(chats?.log).toBe(run?.opts.log);
		expect(reportOf(h.files, c).flows.find((f) => f.id === "settings")).not.toHaveProperty("log");
		const summary = c.stderr.find((l) => l.includes("chats failed")) ?? "";
		expect(summary).toContain(`${chats?.device?.name}`);
		expect(summary).toContain(`log ${run?.opts.log}`);
		expect(summary).toContain(`screenshot ${chats?.screenshot}`);
	});

	test("count 1 runs the flows serially on a single device", async () => {
		await resuite({ count: 1 });
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		write("src/settings/form.tsx", "export const y = 2;\n");
		const c = setup([]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(new Set(h.jobs().map((j) => j.opts.env.WARDEN_UDID)).size).toBe(1);
		expect(h.jobs()).toHaveLength(2);
	});

	test("suite passes (2) → every flow runs twice on its device", async () => {
		await resuite({ passes: 2 });
		const c = setup(["--files", "src/chat/lazy.tsx"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.jobs().map((j) => j.opts.env.WARDEN_PASS)).toEqual(["0", "1"]);
	});

	test("nothing affected → exit 0 without claiming; --dry-run runs nothing", async () => {
		const c = setup([]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.jobs()).toEqual([]);
		expect(c.stderr.join("\n")).toContain("no affected flows");

		c.argv = ["--files", "src/chat/lazy.tsx", "--dry-run"];
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.jobs()).toEqual([]);
		expect(c.stderr.join("\n")).toContain("● chats");
	});

	test("no suite configured: an Expo app's e2e/ flows are the default suite", async () => {
		const c = setup(["--dry-run", "--json"]);
		const app = join(c.env.WARDEN_HOME ?? "", "fresh");
		mkdirSync(join(app, "e2e"), { recursive: true });
		writeFileSync(join(app, "app.json"), JSON.stringify({ expo: { slug: "fresh", ios: { bundleIdentifier: "x.y" } } }));
		writeFileSync(join(app, "e2e/smoke.e2e.ts"), "export {};\n");
		c.cwd = app;
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		const report: E2eReport = JSON.parse(c.stdout.join("\n"));
		expect(report).toMatchObject({ suite: "fresh", platform: "ios", ok: true });
		expect(report.flows.map((f) => f.id)).toEqual(["smoke"]);
	});

	test("suite app: { installMode, resetKeychain } reaches the ensure step on every device", async () => {
		await resuite({ app: { installMode: "clean", resetKeychain: true } });
		const c = setup(["--files", "src/chat/lazy.tsx"]);
		const h = harness();
		const seen: Array<string | undefined> = [];
		h.deps.ensureApp = async (_ctx, _owner, _platform, _deviceId, opts) => {
			seen.push(`${opts.installMode}/${opts.resetKeychain}`);
			return { success: true, data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true } };
		};
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(seen).toEqual(["clean/true"]);
	});

	test("a two-platform suite needs --platform", async () => {
		await resuite({ platform: undefined });
		const c = setup(["--files", "src/chat/lazy.tsx"]);
		expect(await createE2eCommand(harness().deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("pass --platform");
	});

	test("suite project: specs + serve run in the project root and its app is installed", async () => {
		await resuite(
			{ project: "app", app: true, serve: "bun api", serveReady: "file:ready.txt" },
			{ projects: [{ name: "app", root: "packages/ui", bundleId: { ios: "com.x" } }] }
		);
		const c = setup(["--files", "src/chat/lazy.tsx"]);
		const h = harness();
		const projects: Array<string | undefined> = [];
		h.deps.ensureApp = async (_ctx, _owner, _platform, _deviceId, opts) => {
			projects.push(opts.project);
			return { success: true, data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true } };
		};
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		const root = join(dir, "packages/ui");
		expect(projects).toEqual([root]);
		expect(h.jobs()[0]?.opts.cwd).toBe(root);
		expect(h.serve()?.opts.cwd).toBe(root);
		expect(h.probes).toEqual([{ kind: "file", path: join(root, "ready.txt") }]);
	});

	test("suite serve / ports / env reach serve and every runner; a CLI flag overrides serve", async () => {
		await resuite({ serve: "bun api", serveReady: "tcp:9000", ports: ["8091:5"], env: { API: "http://x" } });
		const c = setup(["--files", "src/chat/lazy.tsx"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.serve()?.cmd).toEqual(["sh", "-c", "bun api"]);
		expect(h.probes).toEqual([{ kind: "tcp", host: "127.0.0.1", port: 9000 }]);
		for (const s of [h.serve(), ...h.jobs()]) {
			expect(s?.opts.env.WARDEN_PORT_0).toBe("8091");
			expect(s?.opts.env.WARDEN_PORTS).toBe("8091");
			expect(s?.opts.env.API).toBe("http://x");
		}
		c.argv = ["--files", "src/chat/lazy.tsx", "--serve", "bun other"];
		const h2 = harness();
		await createE2eCommand(h2.deps).run(c);
		expect(h2.serve()?.cmd).toEqual(["sh", "-c", "bun other"]);
	});

	test("serve / serveReady see the leased port ({port}); specs get WARDEN_PORT", async () => {
		await resuite({ serve: "bun api --port {port}", serveReady: "tcp:{port}", ports: ["8091:5"] });
		const c = setup(["--files", "src/chat/lazy.tsx"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.serve()?.cmd).toEqual(["sh", "-c", "bun api --port 8091"]);
		expect(h.probes).toEqual([{ kind: "tcp", host: "127.0.0.1", port: 8091 }]);
		const job = h.jobs()[0];
		expect(job?.opts.env.WARDEN_PORT).toBe("8091");
		expect(job?.opts.env.AGENT_DEVICE_STATE_DIR).toBeUndefined();
		expect(job?.opts.env.WARDEN_AGENT_SESSION).toBeUndefined();
	});

	describe("metro", () => {
		const projects = { projects: [{ name: "app", root: "packages/ui", bundleId: { ios: "com.x" } }] };
		const suite = { project: "app", metro: { launchArgs: ["-E2E", "YES"], env: { EXPO_PUBLIC_E2E: "1" } } };

		test("starts its own Metro in the project root on the first leased port, prewarms, opens the app, stops it last", async () => {
			await resuite({ ...suite, ports: ["8091:5"], spec: { launchArgs: ["--seed", "7"] } }, projects);
			const calls: string[][] = [];
			const c = setup(["--files", "src/chat/lazy.tsx"], calls);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			const root = join(dir, "packages/ui");
			const metro = h.metro();
			expect(metro?.cmd).toEqual(["bunx", "expo", "start", "--dev-client", "--port", "8081"]);
			expect(metro?.opts).toMatchObject({ cwd: root, group: true });
			expect(metro?.opts.log).toBe(join(c.env.WARDEN_HOME ?? "", "batches", "b1", "metro.log"));
			expect(metro?.opts.env).toMatchObject({ CI: "1", EXPO_PUBLIC_E2E: "1", WARDEN_PORT: "8081" });
			expect(h.metroProbes).toEqual([`8081 ${root}`]);
			expect(h.prewarmed).toEqual(["ios http://127.0.0.1:8081"]);
			const job = h.jobs()[0];
			expect(JSON.parse(job?.opts.env.WARDEN_LAUNCH_ARGS ?? "[]")).toEqual([
				"--initialUrl",
				"http://127.0.0.1:8081",
				"-E2E",
				"YES",
				"--seed",
				"7",
			]);
			expect(job?.opts.env.WARDEN_BUNDLE_ID).toBe("com.x");
			expect(job?.opts.env).toMatchObject({
				WARDEN_METRO_URL: "http://127.0.0.1:8081",
				WARDEN_PORT: "8081",
				WARDEN_PORT_0: "8081",
				WARDEN_PORT_1: "8091",
			});
			expect(job?.opts.env.EXPO_PUBLIC_E2E).toBeUndefined();
			const udid = job?.opts.env.WARDEN_UDID ?? "";
			expect(calls).toContainEqual([
				"xcrun",
				"simctl",
				"launch",
				"--terminate-running-process",
				udid,
				"com.x",
				"--initialUrl",
				"http://127.0.0.1:8081",
				"-E2E",
				"YES",
			]);
			expect(h.events.indexOf("metro:start")).toBeLessThan(h.events.indexOf("job:chats"));
			expect(h.events.at(-1)).toBe("metro:SIGTERM");
			expect(c.db.listLeases()).toEqual([]);
		});

		test("runs the project's own node_modules/.bin/expo directly when node can run it, else bunx", async () => {
			await resuite(suite, projects);
			write("packages/ui/node_modules/.bin/expo", "#!/usr/bin/env node\n");
			const withNode = harness();
			withNode.deps.which = (cmd) => (cmd === "node" ? "/usr/bin/node" : cmd === "bun" ? BUN : null);
			expect(await createE2eCommand(withNode.deps).run(setup(["--files", "src/chat/lazy.tsx"]))).toBe(0);
			expect(withNode.metro()?.cmd).toEqual([
				join(dir, "packages/ui/node_modules/.bin/expo"),
				"start",
				"--dev-client",
				"--port",
				"8081",
			]);
			ctx?.cleanup();

			const noNode = harness();
			expect(await createE2eCommand(noNode.deps).run(setup(["--files", "src/chat/lazy.tsx"]))).toBe(0);
			expect(noNode.metro()?.cmd).toEqual(["bunx", "expo", "start", "--dev-client", "--port", "8081"]);
		});

		test("iOS: opening the dev client and closing a late simulator window run side by side", async () => {
			if (process.platform !== "darwin") return;
			await resuite({ ...suite, headless: true }, projects);
			const sim = fakeSimctl([wardenSim(1, "Shutdown")]);
			const launch = Promise.withResolvers<void>();
			const reads: string[] = [];
			const exec: Exec = async (cmd, opts) => {
				if (cmd[0] === "git") return bunExec(cmd, opts);
				if (cmd[0] === "osascript") {
					if ((cmd[4] ?? "").includes("NSScreen")) reads.push("read");
					const windows = [{ title: "warden-iphone-17-1 – iOS 26.5", width: 400, height: 800 }];
					const screen = { x: 0, y: 0, width: 900, height: 900 };
					return { exitCode: 0, stdout: JSON.stringify({ screen, windows }), stderr: "" };
				}
				if (cmd[0] === "xcrun" && cmd[2] === "launch") {
					reads.push("launch:start");
					await launch.promise;
				}
				return sim(cmd, opts);
			};
			ctx = testContext(["--files", "src/chat/lazy.tsx"], { exec });
			ctx.env = { ...ctx.env, ...OWNER_ENV };
			ctx.cwd = dir;
			const h = harness();
			const run = createE2eCommand(h.deps).run(ctx);
			await waitFor(() => reads.includes("launch:start"));
			// the claim's own hide has read the windows once; the late one is the second read, while the launch is still pending
			await waitFor(() => reads.filter((r) => r === "read").length === 2);
			expect(reads.filter((r) => r === "read")).toHaveLength(2);
			expect(h.jobs()).toEqual([]);
			launch.resolve();
			expect(await run).toBe(0);
		});

		test("iOS: warden's own dev-client launch is bounded at 30 s; a launch past it only warns (12-6)", async () => {
			await resuite(suite, projects);
			const sim = fakeSimctl([wardenSim(1, "Booted")]);
			const timeouts: Array<number | undefined> = [];
			const exec: Exec = async (cmd, opts) => {
				if (cmd[0] === "git") return bunExec(cmd, opts);
				if (cmd[0] === "xcrun" && cmd[2] === "launch") {
					timeouts.push(opts?.timeoutMs);
					// a hung launch: only the exec timeout ends it (bunExec kills it with SIGTERM)
					if (opts?.timeoutMs === undefined) await new Promise(() => {});
					return { exitCode: 143, stdout: "", stderr: "" };
				}
				return sim(cmd, opts);
			};
			ctx = testContext(["--files", "src/chat/lazy.tsx"], { exec });
			ctx.env = { ...ctx.env, ...OWNER_ENV };
			ctx.cwd = dir;
			const h = harness();
			expect(await createE2eCommand(h.deps).run(ctx)).toBe(0);
			expect(timeouts).toEqual([30_000]);
			expect(h.jobs()).toHaveLength(1);
			expect(ctx.stderr.join("\n")).toContain("simctl launch --terminate-running-process U1 com.x");
		});

		test("open: false leaves launching the app to the specs", async () => {
			await resuite({ ...suite, metro: { ...suite.metro, open: false } }, projects);
			const calls: string[][] = [];
			const c = setup(["--files", "src/chat/lazy.tsx"], calls);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(h.jobs()[0]?.opts.env.WARDEN_METRO_URL).toBe("http://127.0.0.1:8081");
			expect(calls.filter((cmd) => cmd.includes("launch"))).toEqual([]);
		});

		test("a foreign Metro on the leased port: the run never starts a flow and names the other checkout", async () => {
			await resuite(suite, projects);
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness({ metroOwner: { kind: "foreign", root: "/other/worktree/app" } });
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(h.jobs()).toEqual([]);
			expect(c.stderr.join("\n")).toContain("port 8081 is served by /other/worktree/app, not this worktree");
			expect(h.metro()?.kills).toEqual(["SIGTERM"]);
			expect(c.db.listLeases()).toEqual([]);
		});

		test("a bundle that does not build fails the run before any flow", async () => {
			await resuite(suite, projects);
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness({ prewarm: "fail" });
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(h.jobs()).toEqual([]);
			expect(c.stderr.join("\n")).toContain("SyntaxError");
			expect(h.metro()?.kills).toEqual(["SIGTERM"]);
		});

		const installed = {
			success: true,
			data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true },
		} as const;

		test("Metro starts and prewarms while the app is still installing; stopped last", async () => {
			await resuite({ ...suite, app: true }, projects);
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness();
			const install = Promise.withResolvers<void>();
			let ensures = 0;
			h.deps.ensureApp = async () => {
				ensures++;
				await install.promise;
				return installed;
			};
			const run = createE2eCommand(h.deps).run(c);
			await waitFor(() => h.prewarmed.length === 1);
			expect(ensures).toBe(1);
			expect(h.metro()).toBeDefined();
			expect(h.jobs()).toEqual([]);
			install.resolve();
			expect(await run).toBe(0);
			expect(h.events.indexOf("metro:start")).toBeLessThan(h.events.findIndex((e) => e.startsWith("job:")));
			expect(h.events.at(-1)).toBe("metro:SIGTERM");
			expect(c.db.listLeases()).toEqual([]);
		});

		test("the install fails → the early Metro is stopped, no flow runs, nothing stays leased", async () => {
			await resuite({ ...suite, app: true }, projects);
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness();
			h.deps.ensureApp = async () => ({ success: false, error: "no build" });
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(h.metro()?.kills).toEqual(["SIGTERM"]);
			expect(h.jobs()).toEqual([]);
			expect(c.db.listLeases()).toEqual([]);
			expect(c.stderr.join("\n")).toContain("no build");
		});

		test("the device claim fails → the early Metro is stopped and the port lease released", async () => {
			await resuite({ ...suite, app: true }, projects);
			// no warden sim exists and none may be created: the device claim fails after the port lease
			const sim = fakeSimctl([]);
			const exec: Exec = (cmd, opts) => (cmd[0] === "git" ? bunExec(cmd, opts) : sim(cmd, opts));
			ctx = testContext(["--files", "src/chat/lazy.tsx", "--max", "0", "--no-wait"], { exec });
			ctx.env = { ...ctx.env, ...OWNER_ENV };
			ctx.cwd = dir;
			const c = ctx;
			const h = harness();
			h.deps.ensureApp = async () => installed;
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(h.metro()?.kills).toEqual(["SIGTERM"]);
			expect(h.jobs()).toEqual([]);
			expect(c.db.listLeases()).toEqual([]);
		});

		test("Metro turns out foreign while the app installs → exit 1 naming the other checkout, no flow", async () => {
			await resuite({ ...suite, app: true }, projects);
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness();
			const probe = Promise.withResolvers<void>();
			h.deps.metroProbe = async () => {
				await probe.promise;
				return { kind: "foreign", root: "/other/worktree/app" };
			};
			let ensures = 0;
			h.deps.ensureApp = async () => {
				ensures++;
				probe.resolve();
				await Bun.sleep(5);
				return installed;
			};
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(ensures).toBe(1);
			expect(h.jobs()).toEqual([]);
			expect(c.stderr.join("\n")).toContain("port 8081 is served by /other/worktree/app, not this worktree");
			expect(h.metro()?.kills).toEqual(["SIGTERM"]);
			expect(c.db.listLeases()).toEqual([]);
		});

		test("SIGINT during the install → exit 130, the early Metro is stopped, nothing stays leased", async () => {
			await resuite({ ...suite, app: true }, projects);
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness();
			const install = Promise.withResolvers<void>();
			h.deps.ensureApp = async () => {
				await install.promise;
				return installed;
			};
			const run = createE2eCommand(h.deps).run(c);
			await waitFor(() => h.signals.has("SIGINT") && h.prewarmed.length === 1);
			h.signals.get("SIGINT")?.();
			install.resolve();
			expect(await run).toBe(130);
			expect(h.metro()?.kills).toContain("SIGTERM");
			expect(h.jobs()).toEqual([]);
			expect(c.db.listLeases()).toEqual([]);
		});

		test("SIGINT while the bundle still builds → exit 130 without waiting for it; Metro is stopped (12-5)", async () => {
			await resuite({ ...suite, app: true }, projects);
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness({ prewarm: "hang" });
			const install = Promise.withResolvers<void>();
			h.deps.ensureApp = async () => {
				await install.promise;
				return installed;
			};
			const run = createE2eCommand(h.deps).run(c);
			await waitFor(() => h.signals.has("SIGINT") && h.prewarmed.length === 1);
			h.signals.get("SIGINT")?.();
			install.resolve();
			expect(await run).toBe(130);
			expect(h.events).toContain("prewarm:aborted");
			expect(h.metro()?.kills).toContain("SIGTERM");
			expect(h.jobs()).toEqual([]);
			expect(c.db.listLeases()).toEqual([]);
		});

		test("a claim that fails while the bundle still builds is reported without waiting for it (12-5)", async () => {
			await resuite({ ...suite, app: true }, projects);
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness({ prewarm: "hang" });
			h.deps.ensureApp = async () => {
				await waitFor(() => h.prewarmed.length === 1);
				return { success: false, error: "no build" };
			};
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(h.events).toContain("prewarm:aborted");
			expect(h.metro()?.kills).toEqual(["SIGTERM"]);
			expect(c.stderr.join("\n")).toContain("no build");
		});

		test("Metro's readiness is announced once, under the claim spinner when it is up before the app", async () => {
			await resuite({ ...suite, app: true }, projects);
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const ui = scriptedUi();
			c.ui = ui;
			const h = harness();
			h.deps.ensureApp = async () => {
				await waitFor(() => h.prewarmed.length === 1);
				await Bun.sleep(5);
				return installed;
			};
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			const announced = ui.events.filter((e) => /Metro on :8081 serves/.test(e));
			expect(announced).toHaveLength(1);
			expect(ui.events.indexOf(announced[0] ?? "")).toBeLessThan(ui.events.indexOf("ok: app ready on 1 device(s)"));
			expect(ui.events.filter((e) => e.startsWith("spin: starting Metro"))).toEqual([]);
		});
	});

	describe("jobTimeoutMs", () => {
		test("a spec process still going after the timeout is shot, killed, and its flow fails with exit 124", async () => {
			await resuite({ jobTimeoutMs: 90_000 });
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness({ manual: true });
			const running = createE2eCommand(h.deps).run(c);
			await waitFor(() => h.jobs().length === 1);
			const job = h.jobs()[0];
			expect(job?.opts.group).toBe(true);
			const timer = h.timers.find((t) => t.ms === 90_000);
			timer?.fire();
			await waitFor(() => (job?.kills.length ?? 0) > 0);
			expect(h.shots).toHaveLength(1);
			expect(job?.kills).toEqual(["SIGTERM"]);
			h.timers.find((t) => t.ms === 5_000)?.fire();
			expect(job?.kills).toEqual(["SIGTERM", "SIGKILL"]);
			job?.finish(137);
			expect(await running).toBe(1);
			expect(c.stderr.join("\n")).toContain("chats still running on");
			const report = reportOf(h.files, c);
			expect(report.flows.find((f) => f.id === "chats")).toMatchObject({ verdict: "failed", attempts: 1 });
			const batch = JSON.parse(h.files.get(join(c.env.WARDEN_HOME ?? "", "batches", "b1", "batch.json")) ?? "{}");
			expect(batch.jobs[0].exitCode).toBe(124);
		});

		test("a spec process that finishes in time disarms its timeout; the default is 10 min", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			// the 120 s timer is the warm-up's
			expect(h.timers.filter((t) => t.ms !== 120_000).map((t) => [t.ms, t.cancelled])).toEqual([[600_000, true]]);
		});
	});

	describe("built-in runner", () => {
		test("job env: the spec contract, an out dir per worker and attempt, no state-dir leftovers", async () => {
			await resuite({
				spec: {
					bundleId: "com.demo",
					launchArgs: ["--seed", "7"],
					timeout: "3m",
					actionTimeout: "20s",
					assertionTimeout: "2s",
				},
			});
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			const job = h.jobs()[0];
			expect(job?.cmd).toEqual([
				BUN,
				"test",
				"--preload",
				PRELOAD,
				"--timeout",
				"210000",
				join(dir, "flows/chats.e2e.ts"),
			]);
			expect(job?.opts.env).toMatchObject({
				WARDEN_PLATFORM: "ios",
				WARDEN_BUNDLE_ID: "com.demo",
				WARDEN_LAUNCH_ARGS: '["--seed","7"]',
				WARDEN_E2E_OUT: join(c.env.WARDEN_HOME ?? "", "batches", "b1", "e2e", `${job?.opts.env.WARDEN_WORKER}-0`),
				WARDEN_E2E_TIMEOUT: "180000",
				WARDEN_E2E_ACTION_TIMEOUT: "20000",
				WARDEN_E2E_ASSERTION_TIMEOUT: "2000",
				WARDEN_E2E_FLOWS_DIR: join(dir, "flows"),
				WARDEN_HELPER_DIR: "/opt/warden",
			});
			for (const gone of ["WARDEN_AGENT_SESSION", "WARDEN_FLOWS", "WARDEN_FLOW_PATHS"])
				expect(job?.opts.env[gone]).toBeUndefined();
		});

		test("defaults: 2m / 30s / 5s, no launch args without Metro, WARDEN_HELPER_DIR from the shell wins", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			c.env = { ...c.env, WARDEN_HELPER_DIR: "/mine" };
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(h.jobs()[0]?.opts.env).toMatchObject({
				WARDEN_BUNDLE_ID: "com.x",
				WARDEN_LAUNCH_ARGS: "[]",
				WARDEN_E2E_TIMEOUT: "120000",
				WARDEN_E2E_ACTION_TIMEOUT: "30000",
				WARDEN_E2E_ASSERTION_TIMEOUT: "5000",
				WARDEN_HELPER_DIR: "/mine",
			});
		});

		test("the bundle id falls back to the project's for the platform", async () => {
			await resuite(
				{ project: "app", spec: undefined },
				{ projects: [{ name: "app", root: "packages/ui", bundleId: { ios: "com.project" } }] }
			);
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(h.jobs()[0]?.opts.env.WARDEN_BUNDLE_ID).toBe("com.project");
		});

		test("no bundle id anywhere fails before any device is leased", async () => {
			await resuite({ spec: undefined });
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain("e2e.mobile: no bundle id — set spec.bundleId or projects[].bundleId.ios");
			expect(h.jobs()).toEqual([]);
			expect(c.db.listLeases()).toEqual([]);
		});

		test("bun missing: WARDEN_BUN is used, else an error before leasing", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const none = harness({ bun: null });
			expect(await createE2eCommand(none.deps).run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain("bun >= 1.3 is required on PATH (or set WARDEN_BUN)");
			expect(none.jobs()).toEqual([]);

			c.env = { ...c.env, WARDEN_BUN: "/opt/bun" };
			const set = harness({ bun: null });
			expect(await createE2eCommand(set.deps).run(c)).toBe(0);
			expect(set.jobs()[0]?.cmd[0]).toBe("/opt/bun");
		});

		test("no @delacour/warden-e2e in the repo: the specs run on the copy warden ships", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness({ preload: null, bundled: "/home/e2e-runtime/1/fallback-preload.mjs" });
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(h.jobs()[0]?.cmd.slice(2, 4)).toEqual(["--preload", "/home/e2e-runtime/1/fallback-preload.mjs"]);
		});

		test("no @delacour/warden-e2e and the bundled copy cannot be extracted: the error is surfaced", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness({ preload: null, bundled: "fail" });
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain("could not extract the bundled @delacour/warden-e2e");
			expect(h.jobs()).toEqual([]);
		});

		test("the repo's @delacour/warden-e2e at another version: a clear error, no job", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness({ e2eVersion: "0.0.1" });
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain("does not match warden");
			expect(h.jobs()).toEqual([]);
		});

		test("a bad spec duration is a config error naming the key", async () => {
			await resuite({ spec: { bundleId: "com.x", timeout: "soon" } });
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			expect(await createE2eCommand(harness().deps).run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain("e2e.mobile.spec.timeout");
		});

		test("--dry-run needs neither bun nor the preload", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx", "--dry-run"]);
			expect(await createE2eCommand(harness({ bun: null, preload: null }).deps).run(c)).toBe(0);
		});

		test("a leftover runner / warmRunners key is a migration error", async () => {
			await resuite({ runner: ["bunx", "e2e", "run", "{flowPath}"] });
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			expect(await createE2eCommand(harness().deps).run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain(
				"e2e.mobile.runner was removed: flows run with @delacour/warden-e2e, see spec"
			);
			await resuite({ warmRunners: false });
			const w = setup(["--files", "src/chat/lazy.tsx"]);
			expect(await createE2eCommand(harness().deps).run(w)).toBe(1);
			expect(w.stderr.join("\n")).toContain("e2e.mobile.warmRunners was removed: renamed to warmDrivers");
		});
	});

	describe("isolate: device", () => {
		const flowFiles = () => ["chats", "settings"].map((id) => join(dir, `flows/${id}.e2e.ts`));
		const shardOf = (job: Spawned | undefined) => job?.opts.env.WARDEN_JOB;

		test("one bun test process per device over its round-robin shard of the flows", async () => {
			await resuite({ isolate: "device", count: 2 });
			const c = setup(["--all"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			const jobs = h.jobs().sort((a, b) => (shardOf(a) ?? "").localeCompare(shardOf(b) ?? ""));
			expect(jobs.map(shardOf)).toEqual(["shard-0", "shard-1"]);
			expect(jobs[0]?.cmd).toEqual(bunTest(join(dir, "flows/chats.e2e.ts")));
			expect(jobs[1]?.cmd).toEqual(bunTest(join(dir, "flows/settings.e2e.ts")));
			expect(new Set(jobs.map((j) => j.opts.env.WARDEN_UDID)).size).toBe(2);
			for (const j of jobs) expect(j.opts.env.WARDEN_FLOWS).toBeUndefined();
			expect(c.db.listLeases()).toEqual([]);
			const report = reportOf(h.files, c);
			expect(report).toMatchObject({ ok: true, isolate: "device", mode: "single" });
			expect(report.flows.map((f) => [f.id, f.verdict])).toEqual([
				["chats", "passed"],
				["settings", "passed"],
			]);
		});

		test("one device runs every flow in one process; shards never outnumber flows", async () => {
			await resuite({ isolate: "device", count: 1 });
			const one = harness();
			expect(await createE2eCommand(one.deps).run(setup(["--all"]))).toBe(0);
			expect(one.jobs().map((j) => j.cmd)).toEqual([bunTest(...flowFiles())]);
			expect(one.jobs().map(shardOf)).toEqual(["shard-0"]);

			await resuite({ isolate: "device", count: 5 });
			const many = harness();
			expect(await createE2eCommand(many.deps).run(setup(["--all"]))).toBe(0);
			expect(many.jobs()).toHaveLength(2);
		});

		test("a failing shard fails only its flows", async () => {
			await resuite({ isolate: "device", count: 2 });
			const c = setup(["--all"]);
			const h = harness({ exitCodes: { "shard-1": 1 } });
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(reportOf(h.files, c).flows.map((f) => [f.id, f.verdict])).toEqual([
				["chats", "passed"],
				["settings", "failed"],
			]);
		});

		test("live flow progress: the grid lists a device's shard and marks each flow as its results.jsonl reports it", async () => {
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
			expect(reportOf(h.files, c).flows.map((f) => f.verdict)).toEqual(["failed", "failed"]);
			expect(c.stderr.join("\n")).toContain("shard-0: no results.jsonl — verdict from exit code 1");
		});

		test("per-flow verdicts from results.jsonl: a failing test fails its flow only, the exit code blames the rest", async () => {
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
			expect(report.flows.map((f) => [f.id, f.verdict])).toEqual([
				["chats", "passed"],
				["settings", "failed"],
			]);
			expect(report.flows[1]?.tests?.[0]).toMatchObject({
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
			expect(report.flows.find((f) => f.id === "settings")?.screenshot).toBe("/art/settings-1/failure.png");
			expect(report.flows.find((f) => f.id === "chats")).not.toHaveProperty("screenshot");
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

		test("e2e-report.json carries each flow's tests (title path, status, duration, error, artifacts) and headless", async () => {
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
			expect(report.flows[0]?.verdict).toBe("failed");
			expect(report.flows[0]?.tests).toEqual([
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
			expect(reportOf(h.files, c).flows[0]?.tests).toHaveLength(1);
			expect(c.stderr.join("\n")).not.toContain("no results.jsonl");
		});

		test("a timed-out test fails the flow even when the process exited 0", async () => {
			const h = writing(() => jsonl(spec("chats", "slow", "timed-out")));
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(reportOf(h.files, c).flows[0]).toMatchObject({ verdict: "failed", tests: [{ status: "timed-out" }] });
		});

		test("no results file: the exit code decides, with a warning", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const pass = harness();
			expect(await createE2eCommand(pass.deps).run(c)).toBe(0);
			expect(c.stderr.join("\n")).toContain("chats: no results.jsonl — verdict from exit code 0");
			expect(reportOf(pass.files, c).flows[0]).not.toHaveProperty("tests");
			const fail = harness({ exitCodes: { chats: 1 } });
			expect(await createE2eCommand(fail.deps).run(c)).toBe(1);
		});

		test("an unparseable results file counts as missing; a truncated last line is skipped", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const junk = writing(() => "this is not json\n{oops\n", 1);
			expect(await createE2eCommand(junk.deps).run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain("chats: no results.jsonl — verdict from exit code 1");

			const cut = writing(() => `${jsonl(spec("chats", "opens"))}{"file":"${join(dir, "flows/chats.e2e.ts")}","ti`);
			expect(await createE2eCommand(cut.deps).run(c)).toBe(0);
			expect(reportOf(cut.files, c).flows[0]?.tests).toHaveLength(1);
		});

		test("test.only left in a spec fails the run under CI, even when everything passed; locally it does not", async () => {
			const build = () => jsonl(spec("chats", "opens", "passed", { only: true }));
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			c.env = { ...c.env, CI: "true" };
			const h = writing(build);
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain(`test.only left in ${join(dir, "flows/chats.e2e.ts")}`);
			expect(reportOf(h.files, c)).toMatchObject({ ok: false, only: [join(dir, "flows/chats.e2e.ts")] });
			expect(reportOf(h.files, c).flows[0]?.verdict).toBe("passed");

			c.env = { ...c.env, CI: "" };
			expect(await createE2eCommand(writing(build).deps).run(c)).toBe(0);
		});

		test("--no-tui: a line per finished test as results arrive, then a line per finished flow", async () => {
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

		test("per-flow mode prints the same test lines", async () => {
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
			ctx = testContext(argv, { exec });
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
				[bunTest(join(dir, "flows/chats.e2e.ts")), "U1", "iphone-17"],
			]);
			expect(reportOf(h.files, c).flows.map((f) => [f.id, f.leg, f.verdict])).toEqual([
				["chats", "iphone-17", "passed"],
			]);
		});

		test("--devices all: every leg claims its own pool and runs every flow, with its env and only its devices", async () => {
			await resuite({ devices });
			const c = legSetup(["--files", "src/chat/lazy.tsx", "--devices", "all"]);
			const h = harness({ exitCodeFor: (env) => (env.WARDEN_LEG === "ipad" ? 1 : 0) });
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			const byLeg = new Map(h.jobs().map((j) => [j.opts.env.WARDEN_LEG, j]));
			expect([...byLeg.keys()].sort()).toEqual(["ipad", "iphone-17"]);
			expect(byLeg.get("ipad")?.cmd).toEqual(bunTest(join(dir, "flows/chats.e2e.ts")));
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
			expect(report.flows.map((f) => [f.id, f.leg, f.verdict])).toEqual([
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
			ctx = testContext(["--files", "src/chat/lazy.tsx", "--devices", "all"], { exec });
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
			ctx = testContext(["--files", "src/chat/lazy.tsx", "--devices", "all", ...extra], { exec });
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
			ctx = c;
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

		test("legs, isolate device: a late leg's flows show in the --no-tui lines (batch-pipeline R1)", async () => {
			const { c } = await lateLeg(["--no-tui"], false);
			const text = c.stderr.join("\n");
			expect(text).toContain("warden-iphone-17-1 ✓ chats");
			expect(text).toContain("warden-ipad-1 ✓ chats");
		});

		test("legs, isolate device: a late leg's flows count in the grid header's totals (batch-pipeline R1)", async () => {
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

	describe("isolation", () => {
		const jobNames = (h: Harness) => h.jobs().map((j) => j.opts.env.WARDEN_JOB);

		test("a suite that says nothing runs one spec process per device", async () => {
			await resuiteDefault({ count: 2 });
			const c = setup(["--all"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(jobNames(h).sort()).toEqual(["shard-0", "shard-1"]);
			expect(reportOf(h.files, c)).toMatchObject({ ok: true, isolate: "device", mode: "single" });
		});

		test("isolate: flow keeps one process per flow", async () => {
			await resuiteDefault({ isolate: "flow", count: 2 });
			const c = setup(["--all"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(jobNames(h).sort()).toEqual(["chats", "settings"]);
			const report = reportOf(h.files, c);
			expect(report.isolate).toBe("flow");
			expect(report).not.toHaveProperty("mode");
		});

		test("the old mode: per-flow still means a process per flow", async () => {
			await resuiteDefault({ mode: "per-flow", count: 2 });
			const h = harness();
			expect(await createE2eCommand(h.deps).run(setup(["--all"]))).toBe(0);
			expect(jobNames(h).sort()).toEqual(["chats", "settings"]);
		});

		test("passes > 1 needs a process per flow, so the default falls back to it", async () => {
			await resuiteDefault({ passes: 2 });
			const h = harness();
			expect(await createE2eCommand(h.deps).run(setup(["--files", "src/chat/lazy.tsx"]))).toBe(0);
			expect(jobNames(h)).toEqual(["chats", "chats"]);
		});

		test("a CLI --passes 2 also falls back to a process per flow; each pass writes its own out dir (12-10)", async () => {
			await resuiteDefault();
			const h = harness();
			expect(await createE2eCommand(h.deps).run(setup(["--files", "src/chat/lazy.tsx", "--passes", "2"]))).toBe(0);
			expect(jobNames(h)).toEqual(["chats", "chats"]);
			const outs = h.jobs().map((j) => j.opts.env.WARDEN_E2E_OUT ?? "");
			expect(new Set(outs).size).toBe(2);
			expect(outs[1]).toMatch(/-p1$/);
		});

		test("a CLI --passes 2 with isolate: device is refused before anything is claimed (12-10)", async () => {
			await resuiteDefault({ isolate: "device" });
			const h = harness();
			const c = setup(["--files", "src/chat/lazy.tsx", "--passes", "2"]);
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain('--passes 2 needs isolate "flow"');
			expect(h.jobs()).toEqual([]);
			expect(c.db.listLeases()).toEqual([]);
		});

		test("flows run in id order in a device's one process", async () => {
			await resuiteDefault({ count: 1 });
			const h = harness();
			expect(await createE2eCommand(h.deps).run(setup(["--all"]))).toBe(0);
			expect(h.jobs().map((j) => j.cmd)).toEqual([
				bunTest(join(dir, "flows/chats.e2e.ts"), join(dir, "flows/settings.e2e.ts")),
			]);
		});

		test("jobTimeoutMs is per flow: a device's process gets it once for each flow it runs", async () => {
			await resuiteDefault({ count: 1, jobTimeoutMs: 60_000 });
			const device = harness();
			expect(await createE2eCommand(device.deps).run(setup(["--all"]))).toBe(0);
			expect(device.timers.map((t) => t.ms)).toContain(120_000);
			expect(device.timers.map((t) => t.ms)).not.toContain(60_000);

			await resuiteDefault({ isolate: "flow", count: 1, jobTimeoutMs: 60_000 });
			const flow = harness();
			expect(await createE2eCommand(flow.deps).run(setup(["--all"]))).toBe(0);
			expect(flow.timers.map((t) => t.ms)).toContain(60_000);
		});

		test("--job-timeout is per flow too", async () => {
			await resuiteDefault({ count: 1 });
			const h = harness();
			expect(await createE2eCommand(h.deps).run(setup(["--all", "--job-timeout", "30s"]))).toBe(0);
			expect(h.timers.map((t) => t.ms)).toContain(60_000);
		});

		describe("retries", () => {
			const bothRequired = {
				flows: {
					chats: { entries: ["src/app/(app)/chats.tsx"] },
					settings: { entries: ["src/app/(app)/settings.tsx"] },
				},
			};
			const attempt = (env: Record<string, string | undefined>) => Number(env.WARDEN_JOB_SEQ);
			const chatsFile = () => join(dir, "flows/chats.e2e.ts");
			const settingsFile = () => join(dir, "flows/settings.e2e.ts");

			test("a device's retry reruns only the flows that failed", async () => {
				await resuite({ isolate: "device", count: 1, retry: 1, ...bothRequired });
				const c = setup(["--all"]);
				const h: Harness = harness({
					exitCodeFor: (env) => {
						const first = attempt(env) === 0;
						h.files.set(
							resultsPath(env),
							first
								? jsonl(spec("chats", "open"), spec("settings", "toggle", "failed"))
								: jsonl(spec("settings", "toggle"))
						);
						return first ? 1 : 0;
					},
				});
				expect(await createE2eCommand(h.deps).run(c)).toBe(0);
				expect(h.jobs().map((j) => j.cmd)).toEqual([bunTest(chatsFile(), settingsFile()), bunTest(settingsFile())]);
				const report = reportOf(h.files, c);
				expect(report.ok).toBe(true);
				expect(report.flows.map((f) => [f.id, f.verdict, f.attempts])).toEqual([
					["chats", "passed", 1],
					["settings", "passed", 2],
				]);
			});

			test("after a crash the retry runs the flow it died in and the flows it never reached", async () => {
				await resuite({ isolate: "device", count: 1, retry: 1, ...bothRequired });
				write("flows/profile.e2e.ts", "export {};\n");
				const c = setup(["--all"]);
				const profileFile = join(dir, "flows/profile.e2e.ts");
				const h: Harness = harness({
					exitCodeFor: (env) => {
						const first = attempt(env) === 0;
						h.files.set(
							resultsPath(env),
							first
								? jsonl(spec("chats", "open"), spec("profile", "first test"))
								: jsonl(spec("profile", "first test"), spec("settings", "toggle"))
						);
						return first ? 137 : 0;
					},
				});
				expect(await createE2eCommand(h.deps).run(c)).toBe(0);
				expect(h.jobs().map((j) => j.cmd)).toEqual([
					bunTest(chatsFile(), profileFile, settingsFile()),
					bunTest(profileFile, settingsFile()),
				]);
				expect(reportOf(h.files, c).flows.map((f) => [f.id, f.verdict, f.attempts])).toEqual([
					["chats", "passed", 1],
					["profile", "passed", 2],
					["settings", "passed", 2],
				]);
			});

			test("the end-of-run grid shows the last attempt: a flow that failed and then passed on its retry is green", async () => {
				await resuite({ isolate: "device", count: 1, retry: 1, ...bothRequired });
				const c = setup(["--all"]);
				// results older than the run are ignored by the grid's report
				const fresh = { startedAt: Number.MAX_SAFE_INTEGER };
				const h: Harness = harness({
					isTTY: true,
					exitCodeFor: (env) => {
						const first = attempt(env) === 0;
						h.files.set(
							resultsPath(env),
							first
								? jsonl(spec("chats", "open", "passed", fresh), spec("settings", "toggle", "failed", fresh))
								: jsonl(spec("settings", "toggle", "passed", fresh))
						);
						return first ? 1 : 0;
					},
				});
				expect(await createE2eCommand(h.deps).run(c)).toBe(0);
				const frame = h.terminal.join("").split("\u001b[0J").at(-1) ?? "";
				expect(frame).toContain("✓ chats  ✓ settings");
				expect(frame).not.toContain("✗ settings");
			});

			test("a flow that still fails after its retry fails the gate; the one that passed keeps its pass", async () => {
				await resuite({ isolate: "device", count: 1, retry: 1, ...bothRequired });
				const c = setup(["--all"]);
				const h: Harness = harness({
					exitCodeFor: (env) => {
						h.files.set(
							resultsPath(env),
							attempt(env) === 0
								? jsonl(spec("chats", "open"), spec("settings", "toggle", "failed"))
								: jsonl(spec("settings", "toggle", "failed"))
						);
						return 1;
					},
				});
				expect(await createE2eCommand(h.deps).run(c)).toBe(1);
				expect(h.jobs()).toHaveLength(2);
				expect(reportOf(h.files, c).flows.map((f) => [f.id, f.verdict, f.attempts])).toEqual([
					["chats", "passed", 1],
					["settings", "failed", 2],
				]);
			});

			test("a process per flow retries just that flow, as before", async () => {
				await resuite({ isolate: "flow", count: 1, retry: 1 });
				const h = harness({ exitCodes: { chats: 1 } });
				expect(await createE2eCommand(h.deps).run(setup(["--all"]))).toBe(1);
				expect(h.jobs().map((j) => [j.opts.env.WARDEN_JOB, j.cmd.at(-1)])).toEqual([
					["chats", chatsFile()],
					["chats", chatsFile()],
					["settings", settingsFile()],
				]);
			});
		});
	});

	describe("headless", () => {
		test("suite headless: specs get WARDEN_HEADLESS=1, every leg claims headless, the report says so", async () => {
			await resuite({
				headless: true,
				devices: [
					{ profile: "iphone-17", count: 1 },
					{ profile: "ipad", count: 1, default: false },
				],
			});
			const sims = [wardenSim(1, "Booted"), { udid: "P1", name: "warden-ipad-1", state: "Booted" as const }];
			const sim = fakeSimctl(sims);
			const exec: Exec = (cmd, opts) => (cmd[0] === "git" ? bunExec(cmd, opts) : sim(cmd, opts));
			ctx = testContext(["--files", "src/chat/lazy.tsx", "--devices", "all"], { exec });
			ctx.env = { ...ctx.env, ...OWNER_ENV };
			ctx.cwd = dir;
			const h = harness();
			expect(await createE2eCommand(h.deps).run(ctx)).toBe(0);
			expect(h.jobs().map((j) => j.opts.env.WARDEN_HEADLESS)).toEqual(["1", "1"]);
			expect(reportOf(h.files, ctx).headless).toBe(true);
		});

		test("top-level headless is the default; --no-headless beats it and clears WARDEN_HEADLESS", async () => {
			await resuite({}, { headless: true });
			const on = setup(["--files", "src/chat/lazy.tsx"]);
			const h1 = harness();
			expect(await createE2eCommand(h1.deps).run(on)).toBe(0);
			expect(h1.jobs()[0]?.opts.env.WARDEN_HEADLESS).toBe("1");
			expect(reportOf(h1.files, on).headless).toBe(true);
			on.cleanup();

			const off = setup(["--files", "src/chat/lazy.tsx", "--no-headless"]);
			off.env = { ...off.env, WARDEN_HEADLESS: "1" };
			const h2 = harness();
			expect(await createE2eCommand(h2.deps).run(off)).toBe(0);
			expect("WARDEN_HEADLESS" in (h2.jobs()[0]?.opts.env ?? {})).toBe(false);
			expect(reportOf(h2.files, off).headless).toBe(false);
		});

		test("default: not headless; WARDEN_HEADLESS=1 turns it on; --dry-run reports it too", async () => {
			const plain = setup(["--files", "src/chat/lazy.tsx"]);
			const h1 = harness();
			expect(await createE2eCommand(h1.deps).run(plain)).toBe(0);
			expect(reportOf(h1.files, plain).headless).toBe(false);
			plain.cleanup();

			const env = setup(["--files", "src/chat/lazy.tsx", "--dry-run", "--json"]);
			env.env = { ...env.env, WARDEN_HEADLESS: "1" };
			expect(await createE2eCommand(harness().deps).run(env)).toBe(0);
			expect(JSON.parse(env.stdout.join("\n")).headless).toBe(true);
		});
	});

	test("suite setup runs once per device after the app install and before any flow, with the lease env", async () => {
		await resuite({
			setup: "defaults write {udid} Key http://localhost:$WARDEN_PORT_0",
			ports: ["8091:5"],
			env: { A: "1" },
			app: true,
		});
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		write("src/settings/form.tsx", "export const y = 2;\n");
		const c = setup(["--count", "2"]);
		const h = harness();
		h.deps.ensureApp = async () => {
			h.events.push("app");
			return { success: true, data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true } };
		};
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		const setups = h.setups();
		expect(setups).toHaveLength(2);
		const udids = setups.map((s) => s.opts.env.WARDEN_UDID).sort();
		expect(new Set(udids).size).toBe(2);
		for (const s of setups) {
			expect(s.cmd).toEqual([
				"sh",
				"-c",
				`defaults write ${s.opts.env.WARDEN_UDID} Key http://localhost:$WARDEN_PORT_0`,
			]);
			expect(s.opts.env).toMatchObject({
				WARDEN_PORT_0: "8091",
				WARDEN_APP_PATH: "/c/A.app",
				WARDEN_APP_HASH: "H",
				A: "1",
			});
			expect(s.opts.cwd).toBe(dir);
			expect(s.opts.log).toMatch(/logs\/setup-\d\.log$/);
		}
		const firstJob = h.events.findIndex((e) => e.startsWith("job:"));
		const lastSetup = h.events.map((e) => e.startsWith("setup:")).lastIndexOf(true);
		expect(h.events.indexOf("app")).toBeLessThan(h.events.findIndex((e) => e.startsWith("setup:")));
		expect(lastSetup).toBeLessThan(firstJob);
		const report = reportOf(h.files, c);
		expect(report.setup?.map((d) => [d.ok, d.exitCode])).toEqual([
			[true, 0],
			[true, 0],
		]);
		expect(report.setup?.[0]?.log).toMatch(/setup-0\.log$/);
	});

	test("a device whose setup fails is dropped; its flows run on the rest", async () => {
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
		const jobDevices = new Set(h.jobs().map((j) => j.opts.env.WARDEN_UDID));
		expect(jobDevices.size).toBe(1);
		expect(jobDevices.has(bad ?? "")).toBe(false);
		expect(h.jobs()).toHaveLength(2);
		const report = reportOf(h.files, c);
		expect(report.setup?.filter((d) => !d.ok).map((d) => [d.udid, d.exitCode])).toEqual([[bad, 3]]);
		expect(c.stderr.join("\n")).toContain("setup failed on");
	});

	test("setup failing on every device fails the run and names the setup log", async () => {
		await resuite({ setup: "prep {udid}" });
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		write("src/settings/form.tsx", "export const y = 2;\n");
		const c = setup(["--count", "2"]);
		const h = harness({ exitCodeFor: () => 1 });
		expect(await createE2eCommand(h.deps).run(c)).toBe(1);
		expect(h.jobs()).toEqual([]);
		expect(c.stderr.join("\n")).toMatch(/setup failed on every device.*setup-\d\.log/s);
		const report = reportOf(h.files, c);
		expect(report.ok).toBe(false);
		expect(report.setup?.every((d) => !d.ok)).toBe(true);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("a slimmed device is recorded as slimmed, so a later plain claim restores it", async () => {
		await resuite({ slim: true });
		const c = setup(["--files", "src/chat/lazy.tsx", "--no-shutdown"]);
		c.db.recordDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1", profile: "iphone-17" }, 0);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.slimmed).toEqual(["U1"]);
		expect(c.db.listDevices().find((d) => d.id === "U1")?.slimmedAt).toBe(c.now());
	});

	test("a device recorded as slimmed that the claim did not boot is not probed again (12-4)", async () => {
		await resuite({ slim: true });
		const c = setup(["--files", "src/chat/lazy.tsx", "--no-shutdown"]);
		c.db.recordDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1", profile: "iphone-17" }, 0);
		c.db.setSlimmed("ios", "U1", 5);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.slimmed).toEqual([]);
		expect(reportOf(h.files, c).setup).toEqual([{ worker: 0, udid: "U1", ok: true, slim: { jobs: 0 } }]);
	});

	test("a device recorded as slimmed that the claim booted is slimmed again (12-4)", async () => {
		await resuite({ slim: true });
		const sim = fakeSimctl([wardenSim(1, "Shutdown")]);
		const exec: Exec = (cmd, opts) => (cmd[0] === "git" ? bunExec(cmd, opts) : sim(cmd, opts));
		ctx = testContext(["--files", "src/chat/lazy.tsx", "--no-shutdown"], { exec });
		ctx.env = { ...ctx.env, ...OWNER_ENV };
		ctx.cwd = dir;
		ctx.db.recordDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1", profile: "iphone-17" }, 0);
		ctx.db.setSlimmed("ios", "U1", 5);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(ctx)).toBe(0);
		expect(h.slimmed).toEqual(["U1"]);
	});

	test("the slim starts when the device is leased, alongside its app install (12-4)", async () => {
		await resuite(
			{ project: "app", app: true, slim: true, setup: "prep {udid}" },
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
		await waitFor(() => h.slimmed.length === 1);
		expect(h.slimmed).toEqual(["U1"]);
		expect(h.events).not.toContain("app:end");
		install.resolve();
		expect(await run).toBe(0);
		// the setup command still waits for the slim
		expect(h.events.indexOf("slim:U1")).toBeLessThan(h.events.indexOf("setup:U1"));
	});

	test("suite slim: every device is slimmed before its setup; a failed slim only warns", async () => {
		await resuite({ slim: true, setup: "prep {udid}" });
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		write("src/settings/form.tsx", "export const y = 2;\n");
		const c = setup(["--count", "2"]);
		const h = harness({ slim: "fail" });
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.slimmed).toHaveLength(2);
		for (const udid of h.slimmed) {
			expect(h.events.indexOf(`slim:${udid}`)).toBeLessThan(h.events.indexOf(`setup:${udid}`));
		}
		expect(c.stderr.join("\n")).toContain("slim");
		expect(c.stderr.join("\n")).toContain("not booted");
		expect(reportOf(h.files, c).setup?.every((d) => d.ok && d.slim !== undefined)).toBe(true);
	});

	test("slim alone (no setup command) still slims", async () => {
		await resuite({ slim: true });
		const c = setup(["--files", "src/chat/lazy.tsx"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.slimmed).toHaveLength(1);
		expect(h.setups()).toEqual([]);
	});

	test("slim on android is skipped with a note, not refused; the android devices are never slimmed", async () => {
		await resuite({ slim: true, setup: "prep {udid}" });
		const calls: string[][] = [];
		const c = setup(["--files", "src/chat/lazy.tsx", "--platform", "android"], calls);
		const h = harness();
		await createE2eCommand(h.deps).run(c);
		const stderr = c.stderr.join("\n");
		expect(stderr.split("\n").filter((line) => line.includes("slim is iOS-only; skipped on android"))).toHaveLength(1);
		// not refused at config: the run went on to claim android devices
		expect(calls.some((call) => call[0] === "emulator")).toBe(true);
		expect(h.slimmed).toEqual([]);
	});

	test("--all runs every flow with no diff; include / exclude narrow it", async () => {
		const c = setup(["--all"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(
			h
				.jobs()
				.map((j) => j.opts.env.WARDEN_JOB)
				.sort()
		).toEqual(["chats", "settings"]);
		expect(c.stderr.join("\n")).toContain("2/2 flow(s) passed");

		await resuite({ exclude: ["settings"] });
		const c2 = setup(["--all"]);
		const h2 = harness();
		expect(await createE2eCommand(h2.deps).run(c2)).toBe(0);
		expect(h2.jobs().map((j) => j.opts.env.WARDEN_JOB)).toEqual(["chats"]);
	});

	test("--flows runs exactly the named flows; an unknown one fails", async () => {
		const c = setup(["--flows", "settings"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.jobs().map((j) => j.opts.env.WARDEN_JOB)).toEqual(["settings"]);

		const bad = setup(["--flows", "nope"]);
		expect(await createE2eCommand(harness().deps).run(bad)).toBe(1);
		expect(bad.stderr.join("\n")).toContain('"nope" matches no flow');

		const both = setup(["--all", "--flows", "chats"]);
		expect(await createE2eCommand(harness().deps).run(both)).toBe(1);
		expect(both.stderr.join("\n")).toContain("exclusive");
	});

	describe("device shutdown", () => {
		/** setup() whose two sims warden created, so they're its to shut down; `CI` set as given (`undefined`: a local shell) */
		function wardenSetup(argv: string[], calls: string[][], ci?: string): TestContext {
			const c = setup(argv, calls);
			c.env = { ...c.env, CI: ci };
			for (const n of [1, 2])
				c.db.recordDevice({ platform: "ios", id: `U${n}`, name: `warden-iphone-17-${n}`, profile: "iphone-17" }, 0);
			return c;
		}
		const shutdowns = (calls: string[][]) => calls.filter((x) => x[2] === "shutdown").map((x) => x[3]);

		test("under CI a passed gate shuts the devices warden created down, then releases them", async () => {
			const calls: string[][] = [];
			const c = wardenSetup(["--all", "--count", "2"], calls, "true");
			expect(await createE2eCommand(harness().deps).run(c)).toBe(0);
			expect(shutdowns(calls).sort()).toEqual(["U1", "U2"]);
			expect(c.db.listLeases()).toEqual([]);
		});

		test("locally a passed gate leaves the devices booted for the next run, and still releases them", async () => {
			const calls: string[][] = [];
			const c = wardenSetup(["--all", "--count", "2"], calls);
			expect(await createE2eCommand(harness().deps).run(c)).toBe(0);
			expect(shutdowns(calls)).toEqual([]);
			expect(c.db.listLeases()).toEqual([]);
		});

		test("CI set to 0, false or empty is a local shell", async () => {
			for (const ci of ["0", "false", ""]) {
				const calls: string[][] = [];
				const c = wardenSetup(["--all", "--count", "2"], calls, ci);
				expect(await createE2eCommand(harness().deps).run(c)).toBe(0);
				expect(shutdowns(calls)).toEqual([]);
			}
		});

		test("shutdown: always shuts down locally too", async () => {
			await resuite({ shutdown: "always" });
			const calls: string[][] = [];
			const c = wardenSetup(["--all", "--count", "2"], calls);
			expect(await createE2eCommand(harness().deps).run(c)).toBe(0);
			expect(shutdowns(calls).sort()).toEqual(["U1", "U2"]);
		});

		test("shutdown: idle keeps the devices booted under CI too", async () => {
			await resuite({ shutdown: "idle" });
			const calls: string[][] = [];
			const c = wardenSetup(["--all", "--count", "2"], calls, "true");
			expect(await createE2eCommand(harness().deps).run(c)).toBe(0);
			expect(shutdowns(calls)).toEqual([]);
		});

		test("gate failed → devices left running for inspection in every mode; leases still released", async () => {
			for (const [shutdown, ci] of [
				["always", "true"],
				["always", undefined],
				["idle", "true"],
			] as const) {
				await resuite({ shutdown });
				const calls: string[][] = [];
				const c = wardenSetup(["--all", "--count", "2"], calls, ci);
				expect(await createE2eCommand(harness({ exitCodes: { chats: 1 } }).deps).run(c)).toBe(1);
				expect(shutdowns(calls)).toEqual([]);
				expect(c.db.listLeases()).toEqual([]);
			}
		});

		test("--no-shutdown keeps devices running after a pass, whatever the suite or CI say", async () => {
			await resuite({ shutdown: "always" });
			const calls: string[][] = [];
			const c = wardenSetup(["--all", "--no-shutdown"], calls, "true");
			expect(await createE2eCommand(harness().deps).run(c)).toBe(0);
			expect(shutdowns(calls)).toEqual([]);
			expect(c.db.listLeases()).toEqual([]);
		});

		test("a device that was already running and not warden's stays up", async () => {
			const calls: string[][] = [];
			const c = setup(["--all"], calls);
			c.env = { ...c.env, CI: "true" };
			expect(await createE2eCommand(harness().deps).run(c)).toBe(0);
			expect(shutdowns(calls)).toEqual([]);
		});
	});
});
