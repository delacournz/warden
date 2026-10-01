import { afterEach, describe, expect, test } from "bun:test";
import { HEARTBEAT_INTERVAL_MS } from "@delacour/warden-core/config.defaults";
import { type ChildHandle, splitCommand, splitOperands } from "../lease-session";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { scriptedUi, type TestContext, testContext } from "../testing";
import { createRunCommand, type RunDeps } from "./run";

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
			isPortFree: async (port) => port !== 8091,
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

describe("splitOperands", () => {
	test("platform = the operand before --; the rest is the command", () => {
		expect(splitOperands(["ios", "--", "a", "b"], ["ios", "a", "b"])).toEqual({
			success: true,
			data: { platformArg: "ios", cmd: ["a", "b"] },
		});
		expect(splitOperands(["--", "a"], ["a"])).toEqual({ success: true, data: { cmd: ["a"] } });
		expect(splitOperands(["ios", "x", "--", "a"], ["ios", "x", "a"]).success).toBe(false);
		expect(splitOperands(["ios", "a"], ["ios", "a"]).success).toBe(false);
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

	test("leases one port per --port spec, exports WARDEN_PORT_<i>, releases on exit", async () => {
		const c = setup(["ios", "--port", "8091:20", "--port", "3208:20", "--", "true"]);
		const h = harness();
		const running = createRunCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0);
		const env = h.spawned[0]?.env;
		expect(env?.WARDEN_PORT_0).toBe("8092");
		expect(env?.WARDEN_PORT_1).toBe("3208");
		expect(env?.WARDEN_PORTS).toBe("8092,3208");
		const portLeases = c.db.listLeases().filter((l) => l.resource.kind === "port");
		expect(portLeases.map((l) => l.pid)).toEqual([777, 777]);
		h.finish(0);
		expect(await running).toBe(0);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("bad --port spec → exit 1, device leases released", async () => {
		const c = setup(["ios", "--port", "nope", "--", "true"]);
		const h = harness();
		expect(await createRunCommand(h.deps).run(c)).toBe(1);
		expect(h.spawned).toEqual([]);
		expect(c.db.listLeases()).toEqual([]);
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

	test("--app ensures the app on each claimed device before spawning; exports WARDEN_APP_*", async () => {
		const c = setup(["ios", "--count", "2", "--app", "--project", "apps/x", "--no-eas", "--", "true"]);
		const h = harness();
		const seen: string[] = [];
		h.deps.ensureApp = async (_ctx, _owner, platform, deviceId, opts) => {
			seen.push(`${platform} ${deviceId} ${opts.project} eas=${opts.eas} build=${opts.build}`);
			return { success: true, data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true } };
		};
		const running = createRunCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0);
		expect(seen.sort()).toEqual(["ios U1 apps/x eas=false build=true", "ios U2 apps/x eas=false build=true"]);
		expect(h.spawned[0]?.env.WARDEN_APP_PATH).toBe("/c/A.app");
		expect(h.spawned[0]?.env.WARDEN_APP_HASH).toBe("H");
		h.finish(0);
		expect(await running).toBe(0);
	});

	test("--app failure → leases released, exit 1, child never spawned", async () => {
		const c = setup(["ios", "--app", "--port", "8091:20", "--", "true"]);
		const h = harness();
		h.deps.ensureApp = async () => ({ success: false, error: "no build for fingerprint H" });
		expect(await createRunCommand(h.deps).run(c)).toBe(1);
		expect(h.spawned).toEqual([]);
		expect(c.db.listLeases()).toEqual([]);
		expect(c.stderr.join("\n")).toContain("no build for fingerprint H");
	});

	test("everything after -- reaches the child untouched (options, --help, a second --)", async () => {
		const c = setup(["ios", "--count", "2", "--", "bun", "test", "--x", "--help", "--count", "9", "--", "y"]);
		const h = harness();
		const running = createRunCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0);
		expect(h.spawned[0]?.cmd).toEqual(["bun", "test", "--x", "--help", "--count", "9", "--", "y"]);
		expect(c.db.listLeases()).toHaveLength(2);
		h.finish(0);
		expect(await running).toBe(0);
	});

	test("options after the platform are parsed, the platform can come after options", async () => {
		const c = setup(["--label", "x", "ios", "--count", "2", "--", "true"]);
		const h = harness();
		const running = createRunCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0);
		expect(c.db.listLeases().map((l) => l.label)).toEqual(["x", "x"]);
		h.finish(0);
		expect(await running).toBe(0);
	});

	test("--json: one JSON document on stdout", async () => {
		const c = setup(["ios", "--json", "--", "true"]);
		const h = harness();
		const running = createRunCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out).toMatchObject({ cmd: ["true"], ports: [] });
		expect(out.leases).toHaveLength(1);
		h.finish(0);
		expect(await running).toBe(0);
	});

	test("no platform in a terminal → asks; spinner covers the claim and stops before the child spawns", async () => {
		const c = setup(["--", "true"]);
		const ui = scriptedUi({ interactive: true, select: ["ios"] });
		c.ui = ui;
		const h = harness();
		const spawn = h.deps.spawn;
		h.deps.spawn = (cmd, env) => {
			ui.events.push("spawn");
			return spawn(cmd, env);
		};
		const running = createRunCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0);
		expect(ui.events[0]).toBe("select: Which platform?");
		expect(ui.events[1]).toStartWith("spin: claiming 1 iphone-17 ios");
		expect(ui.events.slice(-3)).toEqual([expect.stringMatching(/^ok: leased /), "stop", "spawn"]);
		h.finish(0);
		expect(await running).toBe(0);
	});

	test("no platform, not a terminal → exit 1, nothing claimed", async () => {
		const c = setup(["--", "true"]);
		const h = harness();
		expect(await createRunCommand(h.deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("missing platform");
		expect(c.db.listLeases()).toEqual([]);
	});

	test("unknown option before -- → commander usage error, exit 1", async () => {
		const c = setup(["ios", "--bogus", "--", "true"]);
		const h = harness();
		expect(await createRunCommand(h.deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("unknown option '--bogus'");
		expect(h.spawned).toEqual([]);
	});

	test("--no-eas without --app → exit 1", async () => {
		const c = setup(["ios", "--no-eas", "--", "true"]);
		const h = harness();
		expect(await createRunCommand(h.deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("need --app");
	});

	test("--project without --app → exit 1", async () => {
		const c = setup(["ios", "--project", "x", "--", "true"]);
		const h = harness();
		expect(await createRunCommand(h.deps).run(c)).toBe(1);
		expect(c.db.listLeases()).toEqual([]);
	});
});
