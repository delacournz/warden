import { afterEach, describe, expect, test } from "bun:test";
import { HEARTBEAT_INTERVAL_MS } from "@warden/core/config.defaults";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { type ChildHandle, createRunCommand, type RunDeps, splitCommand } from "./run";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

type Harness = {
	deps: RunDeps;
	spawned: Array<{ cmd: string[]; env: Record<string, string | undefined> }>;
	kills: string[];
	signals: Map<string, () => void>;
	tick: () => void;
	intervalMs: number[];
	finish: (code: number) => void;
};

function harness(opts: { spawnThrows?: boolean } = {}): Harness {
	let resolveExit: (code: number) => void = () => {};
	let tickFn: () => void = () => {};
	const h: Harness = {
		spawned: [],
		kills: [],
		signals: new Map(),
		intervalMs: [],
		tick: () => tickFn(),
		finish: (code) => resolveExit(code),
		deps: {
			pid: 777,
			spawn: (cmd, env): ChildHandle => {
				if (opts.spawnThrows) throw new Error("ENOENT: nope");
				h.spawned.push({ cmd, env });
				return {
					exited: new Promise<number>((resolve) => {
						resolveExit = resolve;
					}),
					kill: (signal) => {
						h.kills.push(signal);
					},
				};
			},
			onSignal: (signal, handler) => {
				h.signals.set(signal, handler);
				return () => h.signals.delete(signal);
			},
			every: (ms, fn) => {
				h.intervalMs.push(ms);
				tickFn = fn;
				return () => {
					tickFn = () => {};
				};
			},
		},
	};
	return h;
}

function setup(argv: string[]): TestContext {
	ctx = testContext(argv, { exec: fakeSimctl([wardenSim(1, "Booted"), wardenSim(2, "Booted")]) });
	ctx.env = { ...ctx.env, ...OWNER_ENV };
	return ctx;
}

async function waitFor(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(1);
}

describe("splitCommand", () => {
	test("splits at the first --", () => {
		expect(splitCommand(["ios", "--count", "2", "--", "bun", "test", "--", "x"])).toEqual({
			flags: ["ios", "--count", "2"],
			cmd: ["bun", "test", "--", "x"],
		});
		expect(splitCommand(["ios"])).toEqual({ flags: ["ios"], cmd: [] });
	});
});

describe("warden run", () => {
	test("claims, exports env, heartbeats, releases, passes exit code through", async () => {
		const c = setup(["ios", "--count", "2", "--label", "e2e", "--", "bun", "e2e"]);
		let clock = c.now();
		c.now = () => clock;
		const h = harness();
		const running = createRunCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0);

		const [child] = h.spawned;
		expect(child?.cmd).toEqual(["bun", "e2e"]);
		const leases = c.db.listLeases();
		expect(leases).toHaveLength(2);
		expect(leases.every((l) => l.pid === 777 && l.label === "e2e")).toBe(true);
		expect(child?.env.WARDEN_UDIDS?.split(",").sort()).toEqual(["U1", "U2"]);
		expect(child?.env.WARDEN_UDID_0).toBeDefined();
		expect(child?.env.WARDEN_UDID_1).toBeDefined();
		expect(child?.env.WARDEN_LEASE_IDS?.split(",").sort()).toEqual(leases.map((l) => l.id).sort());
		expect(child?.env.WARDEN_SESSION_ID).toBe("me");

		expect(h.intervalMs).toEqual([HEARTBEAT_INTERVAL_MS]);
		clock += 5_000;
		h.tick();
		expect(c.db.listLeases().every((l) => l.heartbeatAt === clock)).toBe(true);

		h.finish(3);
		expect(await running).toBe(3);
		expect(c.db.listLeases()).toEqual([]);
		expect(h.signals.size).toBe(0);
	});

	test("forwards SIGINT/SIGTERM to the child", async () => {
		const c = setup(["ios", "--", "sleep", "60"]);
		const h = harness();
		const running = createRunCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0);
		h.signals.get("SIGINT")?.();
		h.signals.get("SIGTERM")?.();
		expect(h.kills).toEqual(["SIGINT", "SIGTERM"]);
		h.finish(130);
		expect(await running).toBe(130);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("accepts repeatable --port (wired later)", async () => {
		const c = setup(["ios", "--port", "8091:20", "--port", "3208:20", "--", "true"]);
		const h = harness();
		const running = createRunCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0);
		h.finish(0);
		expect(await running).toBe(0);
	});

	test("missing command → exit 1, nothing claimed", async () => {
		const c = setup(["ios"]);
		const h = harness();
		expect(await createRunCommand(h.deps).run(c)).toBe(1);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("spawn failure → leases released, exit 127", async () => {
		const c = setup(["ios", "--", "nope"]);
		const h = harness({ spawnThrows: true });
		expect(await createRunCommand(h.deps).run(c)).toBe(127);
		expect(c.db.listLeases()).toEqual([]);
		expect(c.stderr.join("\n")).toContain("ENOENT");
	});

	test("claim failure → exit 1, child never spawned", async () => {
		const c = setup(["ios", "--count", "3", "--max", "2", "--", "true"]);
		const h = harness();
		expect(await createRunCommand(h.deps).run(c)).toBe(1);
		expect(h.spawned).toEqual([]);
	});
});
