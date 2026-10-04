import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeSuiteRepo } from "@delacour/warden-core/affected/fixture.testing";
import { bunExec, type Exec } from "@delacour/warden-core/exec";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { harness } from "./batch.testing";
import { createE2eCommand, type E2eReport } from "./e2e";

let dir: string;
let write: (path: string, text: string) => void;
let ctx: TestContext | undefined;

beforeEach(async () => {
	({ dir, write } = await makeSuiteRepo());
});
afterEach(() => {
	ctx?.cleanup();
	ctx = undefined;
	rmSync(dir, { recursive: true, force: true });
});

/** Swap the fixture for one whose suite has `overrides`. */
async function resuite(overrides: Record<string, unknown>, config: Record<string, unknown> = {}): Promise<void> {
	rmSync(dir, { recursive: true, force: true });
	({ dir, write } = await makeSuiteRepo(overrides, config));
}

function setup(argv: string[]): TestContext {
	const sim = fakeSimctl([wardenSim(1, "Booted"), wardenSim(2, "Booted")]);
	const exec: Exec = (cmd, opts) => (cmd[0] === "git" ? bunExec(cmd, opts) : sim(cmd, opts));
	ctx = testContext(argv, { exec });
	ctx.env = { ...ctx.env, ...OWNER_ENV };
	ctx.cwd = dir;
	return ctx;
}

const reportOf = (files: Map<string, string>, c: TestContext): E2eReport =>
	JSON.parse(files.get(join(c.env.WARDEN_HOME ?? "", "batches", "b1", "e2e-report.json")) ?? "{}");

describe("warden e2e", () => {
	test("runs the affected flows with the suite's runner, in the config dir; report + gate pass", async () => {
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		write("src/settings/form.tsx", "export const y = 2;\n");
		const c = setup(["--count", "2"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		const jobs = h.jobs();
		expect(jobs.map((j) => j.opts.env.WARDEN_JOB).sort()).toEqual(["chats", "settings"]);
		const chats = jobs.find((j) => j.opts.env.WARDEN_JOB === "chats");
		expect(chats?.cmd).toEqual([
			"run-flow",
			join(dir, "flows/chats.yaml"),
			"--device",
			chats?.opts.env.WARDEN_UDID ?? "",
		]);
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

	test("suite app: { clean: true } installs the app cleanly on every device", async () => {
		await resuite({ app: { clean: true } });
		const c = setup(["--files", "src/chat/lazy.tsx"]);
		const h = harness();
		const seen: Array<boolean | undefined> = [];
		h.deps.ensureApp = async (_ctx, _owner, _platform, _deviceId, opts) => {
			seen.push(opts.clean);
			return { success: true, data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true } };
		};
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(seen).toEqual([true]);
	});

	test("a two-platform suite needs --platform", async () => {
		await resuite({ platform: undefined });
		const c = setup(["--files", "src/chat/lazy.tsx"]);
		expect(await createE2eCommand(harness().deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("pass --platform");
	});

	test("suite project: runner + serve run in the project root and its app is installed", async () => {
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

	test("slim alone (no setup command) still slims; slim on android is refused", async () => {
		await resuite({ slim: true });
		const c = setup(["--files", "src/chat/lazy.tsx"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.slimmed).toHaveLength(1);
		expect(h.setups()).toEqual([]);

		c.argv = ["--files", "src/chat/lazy.tsx", "--platform", "android"];
		expect(await createE2eCommand(harness().deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("slim is iOS-only");
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
});
