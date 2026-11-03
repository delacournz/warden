import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bunExec, type Exec } from "@delacour/warden-core/exec";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { scriptedUi, testContext } from "../testing";
import { harness } from "./batch.testing";
import { createE2eCommand, type E2eReport } from "./e2e";
import {
	BUN,
	bunTest,
	ctx,
	dir,
	lateWindowExec,
	PRELOAD,
	reportOf,
	resuite,
	setCtx,
	setup,
	useE2eFixture,
	waitFor,
	write,
} from "./e2e.testing";

useE2eFixture();

describe("warden e2e", () => {
	test("runs the affected specs with bun test, in the config dir; report + gate pass", async () => {
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		write("src/settings/form.tsx", "export const y = 2;\n");
		const c = setup(["--count", "2"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		const jobs = h.jobs();
		expect(jobs.map((j) => j.opts.env.WARDEN_JOB).sort()).toEqual(["chats", "settings"]);
		const chats = jobs.find((j) => j.opts.env.WARDEN_JOB === "chats");
		expect(chats?.cmd).toEqual(bunTest(join(dir, "specs/chats.e2e.ts")));
		expect(chats?.opts.cwd).toBe(dir);
		const report = reportOf(h.files, c);
		expect(report).toMatchObject({ suite: "mobile", platform: "ios", base: "main", ok: true });
		expect(report.specs.map((f) => [f.id, f.verdict, f.required])).toEqual([
			["chats", "passed", true],
			["settings", "passed", false],
		]);
		expect(c.db.listLeases()).toEqual([]);
		expect(c.stderr.join("\n")).toContain("2/2 spec(s) passed — gate passed");
	});

	test("an optional spec failing doesn't fail the gate; a required one does", async () => {
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

	test("a failed spec's report entry carries its failure screenshot; passed specs carry none", async () => {
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		write("src/settings/form.tsx", "export const y = 2;\n");
		const c = setup(["--count", "2"]);
		const h = harness({ exitCodes: { chats: 1 } });
		expect(await createE2eCommand(h.deps).run(c)).toBe(1);
		const report = reportOf(h.files, c);
		const chats = report.specs.find((f) => f.id === "chats");
		const chatsRun = h.jobs().find((j) => j.opts.env.WARDEN_JOB === "chats");
		expect(chats?.screenshot).toBe(chatsRun?.opts.log.replace(/\.log$/, ".png"));
		expect(h.shots).toHaveLength(1);
		expect(report.specs.find((f) => f.id === "settings")).not.toHaveProperty("screenshot");
	});

	test("a failed spec is summarised with its device, log and screenshot", async () => {
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		write("src/settings/form.tsx", "export const y = 2;\n");
		const c = setup(["--count", "2"]);
		const h = harness({ exitCodes: { chats: 1 } });
		expect(await createE2eCommand(h.deps).run(c)).toBe(1);
		const run = h.jobs().find((j) => j.opts.env.WARDEN_JOB === "chats");
		const chats = reportOf(h.files, c).specs.find((f) => f.id === "chats");
		expect(chats?.device?.udid).toBe(run?.opts.env.WARDEN_UDID);
		expect(chats?.device?.name).toMatch(/^warden-iphone-17-/);
		expect(chats?.log).toBe(run?.opts.log);
		expect(reportOf(h.files, c).specs.find((f) => f.id === "settings")).not.toHaveProperty("log");
		const summary = c.stderr.find((l) => l.includes("chats failed")) ?? "";
		expect(summary).toContain(`${chats?.device?.name}`);
		expect(summary).toContain(`log ${run?.opts.log}`);
		expect(summary).toContain(`screenshot ${chats?.screenshot}`);
	});

	test("count 1 runs the specs serially on a single device", async () => {
		await resuite({ count: 1 });
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		write("src/settings/form.tsx", "export const y = 2;\n");
		const c = setup([]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(new Set(h.jobs().map((j) => j.opts.env.WARDEN_UDID)).size).toBe(1);
		expect(h.jobs()).toHaveLength(2);
	});

	test("suite passes (2) → every spec runs twice on its device", async () => {
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
		expect(c.stderr.join("\n")).toContain("no affected specs");

		c.argv = ["--files", "src/chat/lazy.tsx", "--dry-run"];
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.jobs()).toEqual([]);
		expect(c.stderr.join("\n")).toContain("● chats");
	});

	test("no suite configured: an Expo app's e2e/ specs are the default suite", async () => {
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
		expect(report.specs.map((f) => f.id)).toEqual(["smoke"]);
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

	test("--install-mode on a suite without an app is refused before any device is claimed, naming the suite", async () => {
		await resuite({ app: false });
		const c = setup(["--files", "src/chat/lazy.tsx", "--install-mode", "clean"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(1);
		expect(h.jobs()).toEqual([]);
		const err = c.stderr.join("\n");
		expect(err).toContain("--install-mode");
		expect(err).toContain('suite "');
		expect(err).toContain("app");
	});

	test("--reset-keychain and --clean on a suite without an app are refused the same way", async () => {
		await resuite({ app: false });
		for (const flag of [["--install-mode", "clean", "--reset-keychain"], ["--clean"]]) {
			const c = setup(["--files", "src/chat/lazy.tsx", ...flag]);
			expect(await createE2eCommand(harness().deps).run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain('suite "');
		}
	});

	test("--install-mode with --app on the CLI is fine for a suite without an app", async () => {
		await resuite({ app: false });
		const c = setup(["--files", "src/chat/lazy.tsx", "--app", "--install-mode", "clean"]);
		const h = harness();
		h.deps.ensureApp = async () => ({
			success: true,
			data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true },
		});
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
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

	test("a count-only suite with biometrics claims the +bio pool (and a plain one never does)", async () => {
		const bioSim = { udid: "B1", name: "warden-iphone-17+bio-1", state: "Booted" as const };
		const claimed = async (suite: Record<string, unknown>): Promise<string[]> => {
			await resuite(suite);
			write("src/chat/lazy.tsx", "export const x = 2;\n");
			const sim = fakeSimctl([bioSim, wardenSim(1, "Booted")], []);
			const exec: Exec = (cmd, opts) => (cmd[0] === "git" ? bunExec(cmd, opts) : sim(cmd, opts));
			setCtx(testContext(["--files", "src/chat/lazy.tsx"], { exec }));
			ctx.env = { ...ctx.env, ...OWNER_ENV };
			ctx.cwd = dir;
			const h = harness();
			expect(await createE2eCommand(h.deps).run(ctx)).toBe(0);
			return h.jobs().map((j) => j.opts.env.WARDEN_UDID ?? "");
		};
		expect(await claimed({ biometrics: true, count: 1 })).toEqual(["B1"]);
		expect(await claimed({ count: 1 })).toEqual(["U1"]);
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
			const exec = lateWindowExec(sim, launch.promise, reads);
			setCtx(testContext(["--files", "src/chat/lazy.tsx"], { exec }));
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
			setCtx(testContext(["--files", "src/chat/lazy.tsx"], { exec }));
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

		test("a foreign Metro on the leased port: the run never starts a spec and names the other checkout", async () => {
			await resuite(suite, projects);
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness({ metroOwner: { kind: "foreign", root: "/other/worktree/app" } });
			expect(await createE2eCommand(h.deps).run(c)).toBe(1);
			expect(h.jobs()).toEqual([]);
			expect(c.stderr.join("\n")).toContain("port 8081 is served by /other/worktree/app, not this worktree");
			expect(h.metro()?.kills).toEqual(["SIGTERM"]);
			expect(c.db.listLeases()).toEqual([]);
		});

		test("a bundle that does not build fails the run before any spec", async () => {
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
			await resuite({ ...suite, app: { kind: "dev" } }, projects);
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

		test("the install fails → the early Metro is stopped, no spec runs, nothing stays leased", async () => {
			await resuite({ ...suite, app: { kind: "dev" } }, projects);
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
			await resuite({ ...suite, app: { kind: "dev" } }, projects);
			// no warden sim exists and none may be created: the device claim fails after the port lease
			const sim = fakeSimctl([]);
			const exec: Exec = (cmd, opts) => (cmd[0] === "git" ? bunExec(cmd, opts) : sim(cmd, opts));
			setCtx(testContext(["--files", "src/chat/lazy.tsx", "--max", "0", "--no-wait"], { exec }));
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

		test("Metro turns out foreign while the app installs → exit 1 naming the other checkout, no spec", async () => {
			await resuite({ ...suite, app: { kind: "dev" } }, projects);
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
			await resuite({ ...suite, app: { kind: "dev" } }, projects);
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
			await resuite({ ...suite, app: { kind: "dev" } }, projects);
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
			await resuite({ ...suite, app: { kind: "dev" } }, projects);
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
			await resuite({ ...suite, app: { kind: "dev" } }, projects);
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
		test("a spec process still going after the timeout is shot, killed, and its spec fails with exit 124", async () => {
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
			expect(report.specs.find((f) => f.id === "chats")).toMatchObject({ verdict: "failed", attempts: 1 });
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
				join(dir, "specs/chats.e2e.ts"),
			]);
			expect(job?.opts.env).toMatchObject({
				WARDEN_PLATFORM: "ios",
				WARDEN_BUNDLE_ID: "com.demo",
				WARDEN_LAUNCH_ARGS: '["--seed","7"]',
				WARDEN_E2E_OUT: join(c.env.WARDEN_HOME ?? "", "batches", "b1", "e2e", `${job?.opts.env.WARDEN_WORKER}-0`),
				WARDEN_E2E_TIMEOUT: "180000",
				WARDEN_E2E_ACTION_TIMEOUT: "20000",
				WARDEN_E2E_ASSERTION_TIMEOUT: "2000",
				WARDEN_E2E_SPECS_DIR: join(dir, "specs"),
				WARDEN_HELPER_DIR: "/opt/warden",
			});
			for (const gone of ["WARDEN_AGENT_SESSION", "WARDEN_SPECS", "WARDEN_SPEC_PATHS"])
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

		test("the suite's conditions (over the top-level ones, per area) reach the spec process as WARDEN_CONDITIONS", async () => {
			await resuite({ conditions: { network: "3g" } }, { conditions: { network: "offline", locale: "fr" } });
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(JSON.parse(h.jobs()[0]?.opts.env.WARDEN_CONDITIONS ?? "null")).toEqual({ network: "3g", locale: "fr" });
		});

		test("the suite's a11y (over the top-level one, per key) is WARDEN_A11Y_AUDIT, and an iOS suite that sets it launches with the inject (WARDEN_A11Y=1)", async () => {
			await resuite(
				{ a11y: { minSeverity: "warning" } },
				{ a11y: { ignore: [{ rule: "duplicate-name" }], minSeverity: "error" } }
			);
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			const env = h.jobs()[0]?.opts.env ?? {};
			expect(JSON.parse(env.WARDEN_A11Y_AUDIT ?? "null")).toEqual({
				ignore: [{ rule: "duplicate-name" }],
				minSeverity: "warning",
			});
			expect(env.WARDEN_A11Y).toBe("1");
		});

		test("--a11y loads the inject for a suite with no a11y key; without either, neither variable is set", async () => {
			const withFlag = setup(["--files", "src/chat/lazy.tsx", "--a11y"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(withFlag)).toBe(0);
			expect(h.jobs()[0]?.opts.env.WARDEN_A11Y).toBe("1");
			expect(h.jobs()[0]?.opts.env.WARDEN_A11Y_AUDIT).toBeUndefined();
			const plain = setup(["--files", "src/chat/lazy.tsx"]);
			const g = harness();
			expect(await createE2eCommand(g.deps).run(plain)).toBe(0);
			expect(g.jobs()[0]?.opts.env.WARDEN_A11Y).toBeUndefined();
		});

		test("no conditions, no WARDEN_CONDITIONS", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(h.jobs()[0]?.opts.env.WARDEN_CONDITIONS).toBeUndefined();
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

		test("no bun on PATH: warden runs the specs as bun itself, unless WARDEN_BUN names one", async () => {
			const c = setup(["--files", "src/chat/lazy.tsx"]);
			const none = harness({ bun: null, execPath: "/usr/local/bin/warden" });
			expect(await createE2eCommand(none.deps).run(c)).toBe(0);
			expect(none.jobs()[0]?.cmd[0]).toBe("/usr/local/bin/warden");
			expect(none.jobs()[0]?.opts.env.BUN_BE_BUN).toBe("1");

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

		test("a leftover warmRunners key is a migration error", async () => {
			await resuite({ warmRunners: false });
			const w = setup(["--files", "src/chat/lazy.tsx"]);
			expect(await createE2eCommand(harness().deps).run(w)).toBe(1);
			expect(w.stderr.join("\n")).toContain("e2e.mobile.warmRunners was removed: renamed to warmDrivers");
		});
	});
});
