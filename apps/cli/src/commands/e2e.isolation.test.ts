import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bunExec, type Exec } from "@delacour/warden-core/exec";
import { PHONE_PROBE_SCRIPT } from "@delacour/warden-core/providers/android";
import { PHONE_PROPS } from "@delacour/warden-core/providers/android.fixtures";
import { jsonl } from "../batch/results.testing";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { scriptedUi, type TestContext, testContext } from "../testing";
import { type Harness, harness } from "./batch.testing";
import { createE2eCommand } from "./e2e";
import {
	bunTest,
	ctx,
	dir,
	reportOf,
	resuite,
	resuiteDefault,
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
	describe("isolation", () => {
		const jobNames = (h: Harness) => h.jobs().map((j) => j.opts.env.WARDEN_JOB);

		test("a suite that says nothing runs one spec process per device", async () => {
			await resuiteDefault({ count: 2 });
			const c = setup(["--all"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(jobNames(h).sort()).toEqual(["shard-0", "shard-1"]);
			expect(reportOf(h.files, c)).toMatchObject({ ok: true, isolate: "device" });
		});

		test("isolate: spec keeps one process per spec", async () => {
			await resuiteDefault({ isolate: "spec", count: 2 });
			const c = setup(["--all"]);
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(jobNames(h).sort()).toEqual(["chats", "settings"]);
			const report = reportOf(h.files, c);
			expect(report.isolate).toBe("spec");
		});

		test("passes > 1 needs a process per spec, so the default falls back to it", async () => {
			await resuiteDefault({ passes: 2 });
			const h = harness();
			expect(await createE2eCommand(h.deps).run(setup(["--files", "src/chat/lazy.tsx"]))).toBe(0);
			expect(jobNames(h)).toEqual(["chats", "chats"]);
		});

		test("a CLI --passes 2 also falls back to a process per spec; each pass writes its own out dir (12-10)", async () => {
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
			expect(c.stderr.join("\n")).toContain('--passes 2 needs isolate "spec"');
			expect(h.jobs()).toEqual([]);
			expect(c.db.listLeases()).toEqual([]);
		});

		test("specs run in id order in a device's one process", async () => {
			await resuiteDefault({ count: 1 });
			const h = harness();
			expect(await createE2eCommand(h.deps).run(setup(["--all"]))).toBe(0);
			expect(h.jobs().map((j) => j.cmd)).toEqual([
				bunTest(join(dir, "specs/chats.e2e.ts"), join(dir, "specs/settings.e2e.ts")),
			]);
		});

		test("jobTimeoutMs is per spec: a device's process gets it once for each spec it runs", async () => {
			await resuiteDefault({ count: 1, jobTimeoutMs: 60_000 });
			const device = harness();
			expect(await createE2eCommand(device.deps).run(setup(["--all"]))).toBe(0);
			expect(device.timers.map((t) => t.ms)).toContain(120_000);
			expect(device.timers.map((t) => t.ms)).not.toContain(60_000);

			await resuiteDefault({ isolate: "spec", count: 1, jobTimeoutMs: 60_000 });
			const spec = harness();
			expect(await createE2eCommand(spec.deps).run(setup(["--all"]))).toBe(0);
			expect(spec.timers.map((t) => t.ms)).toContain(60_000);
		});

		test("--job-timeout is per spec too", async () => {
			await resuiteDefault({ count: 1 });
			const h = harness();
			expect(await createE2eCommand(h.deps).run(setup(["--all", "--job-timeout", "30s"]))).toBe(0);
			expect(h.timers.map((t) => t.ms)).toContain(60_000);
		});

		describe("retries", () => {
			const bothRequired = {
				specs: {
					chats: { entries: ["src/app/(app)/chats.tsx"] },
					settings: { entries: ["src/app/(app)/settings.tsx"] },
				},
			};
			const attempt = (env: Record<string, string | undefined>) => Number(env.WARDEN_JOB_SEQ);
			const chatsFile = () => join(dir, "specs/chats.e2e.ts");
			const settingsFile = () => join(dir, "specs/settings.e2e.ts");

			test("a device's retry reruns only the specs that failed", async () => {
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
				expect(report.specs.map((f) => [f.id, f.verdict, f.attempts])).toEqual([
					["chats", "passed", 1],
					["settings", "passed", 2],
				]);
			});

			test("after a crash the retry runs the spec it died in and the specs it never reached", async () => {
				await resuite({ isolate: "device", count: 1, retry: 1, ...bothRequired });
				write("specs/profile.e2e.ts", "export {};\n");
				const c = setup(["--all"]);
				const profileFile = join(dir, "specs/profile.e2e.ts");
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
				expect(reportOf(h.files, c).specs.map((f) => [f.id, f.verdict, f.attempts])).toEqual([
					["chats", "passed", 1],
					["profile", "passed", 2],
					["settings", "passed", 2],
				]);
			});

			test("the end-of-run grid shows the last attempt: a spec that failed and then passed on its retry is green", async () => {
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

			test("a spec that still fails after its retry fails the gate; the one that passed keeps its pass", async () => {
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
				expect(reportOf(h.files, c).specs.map((f) => [f.id, f.verdict, f.attempts])).toEqual([
					["chats", "passed", 1],
					["settings", "failed", 2],
				]);
			});

			test("a process per spec retries just that spec, as before", async () => {
				await resuite({ isolate: "spec", count: 1, retry: 1 });
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
			setCtx(testContext(["--files", "src/chat/lazy.tsx", "--devices", "all"], { exec }));
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

	test("suite setup runs once per device after the app install and before any spec, with the lease env", async () => {
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

	test("a device whose setup fails is dropped; its specs run on the rest", async () => {
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

	test("slim: true slims with the default profile; an object passes its except / keep through", async () => {
		await resuite({ slim: true });
		const plain = setup(["--files", "src/chat/lazy.tsx", "--no-shutdown"]);
		const first = harness();
		expect(await createE2eCommand(first.deps).run(plain)).toBe(0);
		expect(first.slimProfiles).toEqual([{ except: [], keep: [] }]);

		await resuite({ slim: { except: ["store"], keep: ["com.apple.swcd"] } });
		const custom = setup(["--files", "src/chat/lazy.tsx", "--no-shutdown"]);
		const second = harness();
		expect(await createE2eCommand(second.deps).run(custom)).toBe(0);
		expect(second.slimProfiles).toEqual([{ except: ["store"], keep: ["com.apple.swcd"] }]);
	});

	test("slim: false does not slim", async () => {
		await resuite({ slim: false });
		const c = setup(["--files", "src/chat/lazy.tsx", "--no-shutdown"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.slimmed).toEqual([]);
	});

	test("a slim profile naming an unknown category is a config error before any device is leased", async () => {
		await resuite({ slim: { except: ["nope"] } });
		const c = setup(["--files", "src/chat/lazy.tsx", "--no-shutdown"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).not.toBe(0);
		expect(c.stderr.join("\n")).toContain("nope");
		expect(h.slimmed).toEqual([]);
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

	test("a device recorded as slimmed is not slimmed again even when the claim booted it (the provider did it)", async () => {
		await resuite({ slim: true });
		const sim = fakeSimctl([wardenSim(1, "Shutdown")]);
		const exec: Exec = (cmd, opts) => (cmd[0] === "git" ? bunExec(cmd, opts) : sim(cmd, opts));
		setCtx(testContext(["--files", "src/chat/lazy.tsx", "--no-shutdown"], { exec }));
		ctx.env = { ...ctx.env, ...OWNER_ENV };
		ctx.cwd = dir;
		ctx.db.recordDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1", profile: "iphone-17" }, 0);
		ctx.db.setSlimmed("ios", "U1", 5);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(ctx)).toBe(0);
		expect(h.slimmed).toEqual([]);
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

	test("--all runs every spec with no diff; include / exclude narrow it", async () => {
		const c = setup(["--all"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(
			h
				.jobs()
				.map((j) => j.opts.env.WARDEN_JOB)
				.sort()
		).toEqual(["chats", "settings"]);
		expect(c.stderr.join("\n")).toContain("2/2 spec(s) passed");

		await resuite({ exclude: ["settings"] });
		const c2 = setup(["--all"]);
		const h2 = harness();
		expect(await createE2eCommand(h2.deps).run(c2)).toBe(0);
		expect(h2.jobs().map((j) => j.opts.env.WARDEN_JOB)).toEqual(["chats"]);
	});

	test("--specs runs exactly the named specs; an unknown one fails", async () => {
		const c = setup(["--specs", "settings"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.jobs().map((j) => j.opts.env.WARDEN_JOB)).toEqual(["settings"]);

		const bad = setup(["--specs", "nope"]);
		expect(await createE2eCommand(harness().deps).run(bad)).toBe(1);
		expect(bad.stderr.join("\n")).toContain('"nope" matches no spec');

		const both = setup(["--all", "--specs", "chats"]);
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

		test("locally a passed gate shuts the devices warden created down too, then releases them", async () => {
			const calls: string[][] = [];
			const c = wardenSetup(["--all", "--count", "2"], calls);
			expect(await createE2eCommand(harness().deps).run(c)).toBe(0);
			expect(shutdowns(calls).sort()).toEqual(["U1", "U2"]);
			expect(c.db.listLeases()).toEqual([]);
		});

		test("shutdown: idle keeps the devices booted locally", async () => {
			await resuite({ shutdown: "idle" });
			const calls: string[][] = [];
			const c = wardenSetup(["--all", "--count", "2"], calls);
			expect(await createE2eCommand(harness().deps).run(c)).toBe(0);
			expect(shutdowns(calls)).toEqual([]);
			expect(c.db.listLeases()).toEqual([]);
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
	describe("build kind", () => {
		const projects = { projects: [{ name: "app", root: "packages/ui", bundleId: { ios: "com.x" } }] };
		const withVariant = { projects: [{ ...projects.projects[0], variants: { dev: {} } }] };
		const metro = { launchArgs: ["-E2E", "YES"] };

		/** run the suite, return the kind / variant every device's ensure was asked for, and whether Metro started */
		async function run(
			suite: Record<string, unknown>,
			argv: string[] = []
		): Promise<{
			code: number;
			asked: string[];
			bundleEnv: Array<Record<string, string> | undefined>;
			metro: boolean;
			stderr: string;
		}> {
			await resuite({ project: "app", ...suite }, withVariant);
			const c = setup(["--files", "src/chat/lazy.tsx", ...argv]);
			const h = harness();
			const asked: string[] = [];
			const bundleEnv: Array<Record<string, string> | undefined> = [];
			h.deps.ensureApp = async (_ctx, _owner, _platform, _deviceId, opts) => {
				asked.push(`${opts.kind ?? "-"}/${opts.variant ?? "-"}`);
				bundleEnv.push(opts.bundleEnv);
				return { success: true, data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true } };
			};
			const code = await createE2eCommand(h.deps).run(c);
			return { code, asked, bundleEnv, metro: h.metro() !== undefined, stderr: c.stderr.join("\n") };
		}

		const envMetro = { ...metro, env: { EXPO_PUBLIC_API: "http://127.0.0.1:4599" } };

		test("a repacked run bundles the suite's metro env into the JS (EXPO_PUBLIC_* are inlined at bundle time)", async () => {
			const r = await run({ app: true, metro: envMetro });
			expect(r.asked).toEqual(["simulator/-"]);
			expect(r.bundleEnv).toEqual([{ EXPO_PUBLIC_API: "http://127.0.0.1:4599" }]);
			expect(r.metro).toBe(false);
		});

		test("--kind release bundles the suite's metro env too", async () => {
			const r = await run({ app: true, metro: envMetro }, ["--kind", "release"]);
			expect(r.bundleEnv).toEqual([{ EXPO_PUBLIC_API: "http://127.0.0.1:4599" }]);
		});

		test("--dev leaves the env to Metro: no bundle env", async () => {
			const r = await run({ app: true, metro: envMetro }, ["--dev"]);
			expect(r.bundleEnv).toEqual([undefined]);
			expect(r.metro).toBe(true);
		});

		test("a pinned app.variant keeps its Metro and gets no bundle env", async () => {
			const r = await run({ app: { variant: "dev" }, metro: envMetro });
			expect(r.bundleEnv).toEqual([undefined]);
		});

		test("an app suite installs the repacked simulator build and ignores its metro block", async () => {
			const r = await run({ app: true, metro });
			expect(r.code).toBe(0);
			expect(r.asked).toEqual(["simulator/-"]);
			expect(r.metro).toBe(false);
		});

		test("the suite's app.kind picks the kind", async () => {
			const r = await run({ app: { kind: "release" } });
			expect(r.asked).toEqual(["release/-"]);
		});

		test("--dev installs the dev kind and starts Metro from the suite's block", async () => {
			const r = await run({ app: true, metro }, ["--dev"]);
			expect(r.asked).toEqual(["dev/-"]);
			expect(r.metro).toBe(true);
		});

		test("--dev on a suite with no metro block starts Metro with the defaults", async () => {
			const r = await run({ app: true }, ["--dev"]);
			expect(r.asked).toEqual(["dev/-"]);
			expect(r.metro).toBe(true);
		});

		test("--kind simulator beats the suite's app.kind dev and drops its Metro", async () => {
			const r = await run({ app: { kind: "dev" }, metro }, ["--kind", "simulator"]);
			expect(r.asked).toEqual(["simulator/-"]);
			expect(r.metro).toBe(false);
		});

		test("a suite pinning app.kind dev keeps its Metro without --dev", async () => {
			const r = await run({ app: { kind: "dev" }, metro });
			expect(r.asked).toEqual(["dev/-"]);
			expect(r.metro).toBe(true);
		});

		test("a suite pinning app.variant keeps the variant build and its Metro (no kind)", async () => {
			const r = await run({ app: { variant: "dev" }, metro });
			expect(r.asked).toEqual(["-/dev"]);
			expect(r.metro).toBe(true);
		});

		test("--dev and --kind together are refused before any device is claimed", async () => {
			const r = await run({ app: true }, ["--dev", "--kind", "release"]);
			expect(r.code).toBe(1);
			expect(r.asked).toEqual([]);
			expect(r.stderr).toContain("--dev and --kind can't be combined");
		});

		test("a suite with no app to install keeps its metro block as written", async () => {
			const r = await run({ app: false, metro });
			expect(r.asked).toEqual([]);
			expect(r.metro).toBe(true);
		});
	});
});

describe("warden e2e on physical devices", () => {
	const PHONE = "R5CT1234ABC";
	const ADB_PHONE = `List of devices attached\n${PHONE}            device usb:1-1 product:a54xnaeea model:SM_A546E device:a54x transport_id:2\n\n`;

	/** What adb and the host answer: one phone, boot completed, no simulators; anything else is refused */
	function androidPhoneReply(cmd: readonly string[]): Awaited<ReturnType<Exec>> {
		const line = cmd.slice(1).join(" ");
		const reply = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
		if (line === "devices -l") return reply(ADB_PHONE);
		if (cmd.at(-1) === PHONE_PROBE_SCRIPT) return reply(PHONE_PROPS);
		if (line.endsWith("getprop sys.boot_completed")) return reply("1\n");
		// host reads that are not device actions: the simulator list, memory pressure
		if (cmd[0] === "xcrun" && line === "simctl list devices available -j") return reply('{"devices":{}}');
		if (cmd[0] === "sysctl" || cmd[0] === "memory_pressure") return reply("1\n");
		return { exitCode: 1, stdout: "", stderr: "unexpected" };
	}

	/** adb sees one Android phone; every other command is recorded and refused, so a stray `emu` / `reboot` / `kill` shows up */
	function phoneSetup(argv: string[], calls: string[][]): TestContext {
		const exec: Exec = async (cmd, opts) => {
			if (cmd[0] === "git" || cmd.some((arg) => arg.endsWith("graph-worker.ts"))) return bunExec(cmd, opts);
			calls.push([...cmd]);
			return androidPhoneReply(cmd);
		};
		setCtx(testContext(argv, { exec }));
		ctx.env = { ...ctx.env, ...OWNER_ENV, WARDEN_HEADLESS: "1" };
		ctx.cwd = dir;
		return ctx;
	}

	const argvs = (calls: string[][]) => calls.map((call) => call.slice(1).join(" "));

	test("--physical --platform android: the phone is the only device, with no reboot / emu / kill / shutdown argv", async () => {
		const calls: string[][] = [];
		const c = phoneSetup(["--files", "src/chat/lazy.tsx", "--platform", "android", "--physical"], calls);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		const [job] = h.jobs();
		expect(job?.opts.env.WARDEN_UDIDS).toBe(PHONE);
		expect(job?.opts.env.WARDEN_UDID).toBe(PHONE);
		expect(job?.opts.env.WARDEN_DEVICE_KIND).toBe("physical");
		expect(job?.opts.env.WARDEN_HEADLESS).toBeUndefined();
		expect(job?.opts.env.WARDEN_AFTER_REBOOT).toBeUndefined();
		const FORBIDDEN = new Set(["emu", "reboot", "kill", "shutdown", "boot", "-avd", "erase", "put", "disable"]);
		const forbidden = calls.filter(
			(call) =>
				call[0] === "emulator" ||
				call.slice(1).some((arg) => FORBIDDEN.has(arg)) ||
				(call[1] === "simctl" && call[2] !== "list")
		);
		expect(forbidden).toEqual([]);
		expect(h.slimmed).toEqual([]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("--serial names the phone and implies --physical; the suite's headless setting does not conflict", async () => {
		const calls: string[][] = [];
		const c = phoneSetup(["--files", "src/chat/lazy.tsx", "--platform", "android", "--serial", PHONE], calls);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.jobs()[0]?.opts.env.WARDEN_UDIDS).toBe(PHONE);
	});

	test("the suite's `physical: { ids }` is honoured with no flag at all", async () => {
		await resuite({ platform: "android", physical: { ids: [PHONE] } });
		const calls: string[][] = [];
		const c = phoneSetup(["--files", "src/chat/lazy.tsx"], calls);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.jobs()[0]?.opts.env.WARDEN_UDIDS).toBe(PHONE);
		expect(h.jobs()[0]?.opts.env.WARDEN_DEVICE_KIND).toBe("physical");
	});

	test("a leg with `physical: true` runs on the phone and boots no emulator", async () => {
		await resuite({ platform: "android", devices: [{ profile: "pixel-8", physical: true }] });
		const calls: string[][] = [];
		const c = phoneSetup(["--files", "src/chat/lazy.tsx"], calls);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.jobs()[0]?.opts.env.WARDEN_UDIDS).toBe(PHONE);
		expect(argvs(calls).some((line) => /emulator|-avd/.test(line))).toBe(false);
	});

	test("a physical leg installs the release kind by default, flagged physical; an explicit --kind still wins", async () => {
		const seen: Array<{ kind?: string; physical?: boolean }> = [];
		const withEnsure = (h: Harness): Harness["deps"] => ({
			...h.deps,
			ensureApp: async (_c, _o, _p, _id, o) => {
				seen.push({ ...(o.kind ? { kind: o.kind } : {}), ...(o.physical ? { physical: true } : {}) });
				return { success: true, data: { appPath: "/c/a.apk", hash: "H", source: "cache", installed: true } };
			},
		});
		const run = async (argv: string[]) => {
			const c = phoneSetup(["--files", "src/chat/lazy.tsx", "--platform", "android", ...argv], []);
			const code = await createE2eCommand(withEnsure(harness())).run(c);
			expect(code).toBe(0);
		};
		await run(["--physical", "--app"]);
		await run(["--physical", "--app", "--kind", "simulator"]);
		expect(seen).toEqual([
			{ kind: "release", physical: true },
			{ kind: "simulator", physical: true },
		]);
	});

	test("--serial wins over the suite's `count`: a suite sized for simulators still runs on one phone", async () => {
		await resuite({ platform: "android", count: 2 });
		const calls: string[][] = [];
		const c = phoneSetup(["--files", "src/chat/lazy.tsx", "--serial", PHONE], calls);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.jobs()[0]?.opts.env.WARDEN_UDIDS).toBe(PHONE);
	});

	test("--physical with --count / --headless is refused like a physical claim", async () => {
		const calls: string[][] = [];
		const c = phoneSetup(["--files", "src/chat/lazy.tsx", "--platform", "android", "--physical", "--headless"], calls);
		expect(await createE2eCommand(harness().deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--headless cannot be used with --physical");
	});

	describe("with two phones connected", () => {
		const SECOND = "192.168.1.20:5555";
		const ADB_TWO = `List of devices attached\n${PHONE}            device usb:1-1 product:a54xnaeea model:SM_A546E device:a54x transport_id:2\n${SECOND}      device product:husky model:Pixel_8_Pro device:husky transport_id:5\n\n`;

		function twoPhones(argv: string[], calls: string[][]): TestContext {
			const exec: Exec = async (cmd, opts) => {
				if (cmd[0] === "git" || cmd.some((arg) => arg.endsWith("graph-worker.ts"))) return bunExec(cmd, opts);
				calls.push([...cmd]);
				if (cmd.slice(1).join(" ") === "devices -l") return { exitCode: 0, stdout: ADB_TWO, stderr: "" };
				if (cmd.at(-1) === PHONE_PROBE_SCRIPT)
					return { exitCode: 0, stdout: cmd.includes(SECOND) ? "\n\nHW2\nPixel 8 Pro\n35\n" : PHONE_PROPS, stderr: "" };
				return androidPhoneReply(cmd);
			};
			setCtx(testContext(argv, { exec }));
			ctx.env = { ...ctx.env, ...OWNER_ENV, WARDEN_HEADLESS: "1" };
			ctx.cwd = dir;
			return ctx;
		}

		test("--physical --json fails ambiguous_device (exit 2) before any lease, build or job", async () => {
			let ensured = 0;
			const h = harness();
			const deps: Harness["deps"] = {
				...h.deps,
				ensureApp: async () => {
					ensured++;
					return { success: true, data: { appPath: "/c/a.apk", hash: "H", source: "cache", installed: true } };
				},
			};
			const c = twoPhones(
				["--files", "src/chat/lazy.tsx", "--platform", "android", "--physical", "--app", "--json"],
				[]
			);
			expect(await createE2eCommand(deps).run(c)).toBe(2);
			const doc = JSON.parse(c.stdout.join("\n"));
			expect(doc).toMatchObject({ ok: false, command: "e2e", error: { code: "ambiguous_device" } });
			expect(doc.error.details.candidates.map((x: { id: string }) => x.id)).toEqual([PHONE, SECOND]);
			expect(ensured).toBe(0);
			expect(h.jobs()).toEqual([]);
			expect(c.db.listLeases()).toEqual([]);
		});

		test("in a terminal the picker chooses the device the run uses", async () => {
			const c = twoPhones(["--files", "src/chat/lazy.tsx", "--platform", "android", "--physical"], []);
			c.ui = scriptedUi({ interactive: true, select: [SECOND] });
			const h = harness();
			expect(await createE2eCommand(h.deps).run(c)).toBe(0);
			expect(h.jobs()[0]?.opts.env.WARDEN_UDIDS).toBe(SECOND);
		});
	});
});
