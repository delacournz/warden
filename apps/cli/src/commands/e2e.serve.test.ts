import { describe, expect, test } from "bun:test";
import { bunExec, type Exec } from "@delacour/warden-core/exec";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { testContext } from "../testing";
import { type Harness, harness } from "./batch.testing";
import { createE2eCommand } from "./e2e";
import { ctx, dir, resuite, setCtx, setup, useE2eFixture, waitFor } from "./e2e.testing";

useE2eFixture();

const SERVE = { serve: "bun e2e/fake-api.ts", serveReady: "tcp:9000", ports: ["8091:5"] };

/** every spawn of the suite's `serve` (a process group that is neither a job, a setup nor Metro) */
const serves = (h: Harness) => h.spawned.filter((s) => s.opts.group && !s.opts.job && !s.opts.setup && !s.opts.metro);

/** the run's events with the per-job noise cut down to where the first job started and the last one ended */
const lifecycle = (h: Harness) => h.events.filter((e) => e.startsWith("serve:") || e.startsWith("job:"));

/** serve started once before the first job, killed once after the last one */
function expectOwnedByRun(h: Harness): void {
	expect(serves(h)).toHaveLength(1);
	expect(serves(h)[0]?.kills).toEqual(["SIGTERM"]);
	const events = lifecycle(h);
	expect(events[0]).toBe("serve:start");
	expect(events.filter((e) => e === "serve:start")).toHaveLength(1);
	expect(events.at(-1)).toBe("serve:SIGTERM");
	expect(events.filter((e) => e === "serve:SIGTERM")).toHaveLength(1);
}

describe("warden e2e: suite serve is owned by the run", () => {
	test("count 2, isolate device: one serve for both devices' shards", async () => {
		await resuite({ ...SERVE, isolate: "device", count: 2 });
		const h = harness();
		expect(await createE2eCommand(h.deps).run(setup(["--all"]))).toBe(0);
		expect(h.jobs()).toHaveLength(2);
		expectOwnedByRun(h);
	});

	test("isolate spec, several specs on two devices: one serve for every spec process", async () => {
		await resuite({ ...SERVE, isolate: "spec", count: 2 });
		const h = harness();
		expect(await createE2eCommand(h.deps).run(setup(["--all"]))).toBe(0);
		expect(h.jobs()).toHaveLength(2);
		expectOwnedByRun(h);
	});

	test("isolate spec, one device, retry 1: a retried spec reuses the run's serve", async () => {
		await resuite({ ...SERVE, isolate: "spec", count: 1, retry: 1 });
		const h = harness({ exitCodes: { chats: 1 } });
		expect(await createE2eCommand(h.deps).run(setup(["--all"]))).toBe(1);
		expect(h.jobs().map((j) => j.opts.env.WARDEN_JOB)).toEqual(["chats", "chats", "settings"]);
		expectOwnedByRun(h);
	});

	test("isolate device, retry 1: the retried shard reuses the run's serve", async () => {
		await resuite({ ...SERVE, isolate: "device", count: 2, retry: 1 });
		const h = harness({ exitCodes: { "shard-0": 1 } });
		expect(await createE2eCommand(h.deps).run(setup(["--all"]))).toBe(1);
		expect(h.jobs().filter((j) => j.opts.env.WARDEN_JOB === "shard-0")).toHaveLength(2);
		expectOwnedByRun(h);
	});

	test("passes 2: every pass runs against the same serve", async () => {
		await resuite({ ...SERVE, isolate: "spec", count: 1, passes: 2 });
		const h = harness();
		expect(await createE2eCommand(h.deps).run(setup(["--all"]))).toBe(0);
		expect(
			h
				.jobs()
				.map((j) => j.opts.env.WARDEN_PASS)
				.sort()
		).toEqual(["0", "0", "1", "1"]);
		expectOwnedByRun(h);
	});

	test("two device legs (--devices all): one serve, not one per leg", async () => {
		await resuite({
			...SERVE,
			isolate: "spec",
			devices: [
				{ profile: "iphone-17", count: 1 },
				{ profile: "ipad", count: 1, default: false },
			],
		});
		const sims = [wardenSim(1, "Booted"), { udid: "P1", name: "warden-ipad-1", state: "Booted" as const }];
		const sim = fakeSimctl(sims);
		const exec: Exec = (cmd, opts) => (cmd[0] === "git" ? bunExec(cmd, opts) : sim(cmd, opts));
		setCtx(testContext(["--all", "--devices", "all"], { exec }));
		ctx.env = { ...ctx.env, ...OWNER_ENV };
		ctx.cwd = dir;
		const h = harness();
		expect(await createE2eCommand(h.deps).run(ctx)).toBe(0);
		expect(new Set(h.jobs().map((j) => j.opts.env.WARDEN_UDID)).size).toBe(2);
		expectOwnedByRun(h);
	});

	test("a run failing midway still stops serve exactly once", async () => {
		await resuite({ ...SERVE, isolate: "spec", count: 2, retry: 1 });
		const h = harness({ exitCodes: { chats: 1, settings: 1 } });
		expect(await createE2eCommand(h.deps).run(setup(["--all"]))).toBe(1);
		expectOwnedByRun(h);
	});

	test("SIGINT stops serve exactly once, after the interrupted jobs", async () => {
		await resuite({ ...SERVE, isolate: "spec", count: 2, retry: 1 });
		const h = harness({ manual: true });
		const running = createE2eCommand(h.deps).run(setup(["--all"]));
		await waitFor(() => h.jobs().length === 2);
		h.signals.get("SIGINT")?.();
		for (const job of h.jobs()) job.finish(130);
		expect(await running).toBe(130);
		expect(serves(h)).toHaveLength(1);
		expect(serves(h)[0]?.kills).toEqual(["SIGTERM"]);
		expect(h.jobs()).toHaveLength(2);
	});

	test("every spec process gets the same serve env (fixed ports shared by the run)", async () => {
		await resuite({ ...SERVE, isolate: "spec", count: 2 });
		const h = harness();
		expect(await createE2eCommand(h.deps).run(setup(["--all"]))).toBe(0);
		const ports = new Set([...serves(h), ...h.jobs()].map((s) => s.opts.env.WARDEN_PORT_0));
		expect(ports.size).toBe(1);
		expect(serves(h)[0]?.cmd).toEqual(["sh", "-c", SERVE.serve]);
	});
});
