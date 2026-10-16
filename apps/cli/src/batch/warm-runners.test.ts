import { describe, expect, test } from "bun:test";
import {
	agentDeviceStateDir,
	agentSession,
	findAgentDeviceBin,
	type WarmRun,
	warmRunners,
	warmTargets,
} from "./warm-runners";

const live = [
	{ worker: 2, udid: "A" },
	{ worker: 5, udid: "B" },
];

describe("agentDeviceStateDir / agentSession", () => {
	test("the worker's own dir under the batch, unless the env names one", () => {
		expect(agentDeviceStateDir({}, "/b", 3)).toBe("/b/agent-device/3");
		expect(agentDeviceStateDir({ AGENT_DEVICE_STATE_DIR: "/x" }, "/b", 3)).toBe("/x");
	});

	test("the session prefix is the first device's udid", () => {
		expect(agentSession("A")).toBe("warden-A");
	});
});

describe("warmTargets", () => {
	test("single: every device under the one runner's state dir and session, slot = pool order", () => {
		expect(warmTargets(live, { single: true, env: {}, batchDir: "/b" })).toEqual([
			{ worker: 2, udid: "A", session: "warden-A-0", stateDir: "/b/agent-device/2" },
			{ worker: 5, udid: "B", session: "warden-A-1", stateDir: "/b/agent-device/2" },
		]);
	});

	test("per-flow: each device under its own worker's state dir, slot 0", () => {
		expect(warmTargets(live, { single: false, env: {}, batchDir: "/b" })).toEqual([
			{ worker: 2, udid: "A", session: "warden-A-0", stateDir: "/b/agent-device/2" },
			{ worker: 5, udid: "B", session: "warden-B-0", stateDir: "/b/agent-device/5" },
		]);
	});

	test("no devices → nothing to warm", () => {
		expect(warmTargets([], { single: true, env: {}, batchDir: "/b" })).toEqual([]);
	});
});

describe("findAgentDeviceBin", () => {
	test("the nearest node_modules/.bin/agent-device walking up from cwd", () => {
		const have = new Set(["/repo/node_modules/.bin/agent-device"]);
		expect(findAgentDeviceBin("/repo/apps/example", (p) => have.has(p))).toBe("/repo/node_modules/.bin/agent-device");
	});

	test("none installed → undefined", () => {
		expect(findAgentDeviceBin("/repo/apps/example", () => false)).toBeUndefined();
	});
});

type Spawn = {
	argv: string[];
	env: Record<string, string | undefined>;
	log: string;
	finish: (code: number) => void;
	kills: string[];
};

function fakeRun(over: Partial<WarmRun> = {}) {
	const spawned: Spawn[] = [];
	const timers: Array<{ ms: number; fire: () => void; cancelled: boolean }> = [];
	const run: WarmRun = {
		targets: warmTargets(live, { single: true, env: {}, batchDir: "/b" }),
		bin: "/repo/node_modules/.bin/agent-device",
		env: { WARDEN_UDIDS: "A,B" },
		cwd: "/repo/apps/example",
		logDir: "/b/logs",
		timeoutMs: 120_000,
		spawn: (argv, opts) => {
			let finish: (code: number) => void = () => {};
			const exited = new Promise<number>((resolve) => {
				finish = resolve;
			});
			const entry: Spawn = { argv, env: opts.env, log: opts.log, finish, kills: [] };
			spawned.push(entry);
			return { exited, kill: (signal) => entry.kills.push(signal) };
		},
		after: (ms, fire) => {
			const timer = { ms, fire, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		...over,
	};
	return { run, spawned, timers };
}

describe("warmRunners", () => {
	test("starts every runner at once: prepare ios-runner per device, in its session + state dir, own log", async () => {
		const { run, spawned } = fakeRun();
		const done = warmRunners(run);
		await Bun.sleep(0);
		expect(spawned.map((s) => s.argv)).toEqual([
			[
				"/repo/node_modules/.bin/agent-device",
				"prepare",
				"ios-runner",
				"--platform",
				"ios",
				"--udid",
				"A",
				"--session",
				"warden-A-0",
			],
			[
				"/repo/node_modules/.bin/agent-device",
				"prepare",
				"ios-runner",
				"--platform",
				"ios",
				"--udid",
				"B",
				"--session",
				"warden-A-1",
			],
		]);
		expect(spawned.map((s) => s.env.AGENT_DEVICE_STATE_DIR)).toEqual(["/b/agent-device/2", "/b/agent-device/2"]);
		expect(spawned.map((s) => s.env.WARDEN_UDID)).toEqual(["A", "B"]);
		expect(spawned[0]?.env.WARDEN_UDIDS).toBe("A,B");
		expect(spawned.map((s) => s.log)).toEqual(["/b/logs/warm-2.log", "/b/logs/warm-5.log"]);
		for (const s of spawned) s.finish(0);
		expect(await done).toEqual([
			{ worker: 2, udid: "A", ok: true, exitCode: 0, timedOut: false, log: "/b/logs/warm-2.log" },
			{ worker: 5, udid: "B", ok: true, exitCode: 0, timedOut: false, log: "/b/logs/warm-5.log" },
		]);
	});

	test("a failure is reported, not thrown; the other device still warms", async () => {
		const { run, spawned } = fakeRun();
		const done = warmRunners(run);
		await Bun.sleep(0);
		spawned[0]?.finish(1);
		spawned[1]?.finish(0);
		expect((await done).map((o) => [o.udid, o.ok, o.exitCode])).toEqual([
			["A", false, 1],
			["B", true, 0],
		]);
	});

	test("past the timeout the warm-up is killed and marked timed out; timers are cancelled when done", async () => {
		const { run, spawned, timers } = fakeRun();
		const done = warmRunners(run);
		await Bun.sleep(0);
		expect(timers.map((t) => t.ms)).toEqual([120_000, 120_000]);
		timers[0]?.fire();
		expect(spawned[0]?.kills).toEqual(["SIGKILL"]);
		spawned[0]?.finish(137);
		spawned[1]?.finish(0);
		const out = await done;
		expect(out.map((o) => [o.udid, o.ok, o.timedOut])).toEqual([
			["A", false, true],
			["B", true, false],
		]);
		expect(timers[1]?.cancelled).toBe(true);
	});

	test("a spawn that throws is exit 127", async () => {
		const { run } = fakeRun({
			spawn: () => {
				throw new Error("ENOENT");
			},
		});
		expect((await warmRunners(run)).map((o) => [o.ok, o.exitCode])).toEqual([
			[false, 127],
			[false, 127],
		]);
	});

	test("every warm-up is tracked while it runs (SIGINT stops it)", async () => {
		const tracked: string[] = [];
		const { run, spawned } = fakeRun({
			track: () => {
				tracked.push("+");
				return () => tracked.push("-");
			},
		});
		const done = warmRunners(run);
		await Bun.sleep(0);
		for (const s of spawned) s.finish(0);
		await done;
		expect(tracked).toEqual(["+", "+", "-", "-"]);
	});
});
