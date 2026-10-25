import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { jsOk } from "@delacour/warden-perf/js/js.types";
import { ok } from "@delacour/warden-types/result";
import type { SessionKit } from "../perf/orchestrate";
import { writePlan } from "../perf/plan";
import { createSession, readSession, sessionDir, stopSession } from "../perf/session";
import { fakePerfDeps } from "../perf/testing";
import { type TestContext, testContext } from "../testing";
import { createPerfCollectCommand } from "./perf-collect";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const T0 = 9_000_000;
const sim = { platform: "ios", id: "U1", name: "warden-iphone-17-1" } as const;

function setup(maxDurationMs: number) {
	const clock = { now: T0 };
	const c = testContext([], { now: () => clock.now });
	ctx = c;
	const deps = fakePerfDeps([sim]);
	const made = createSession(c, deps.session, {
		device: { udid: "U1", platform: "ios", name: sim.name },
		target: { udid: "U1", ownedByCaller: true },
		maxDurationMs,
	});
	if (!made.success) throw new Error("create");
	const sleep = async (ms: number) => {
		clock.now += ms;
	};
	return { c, clock, deps, id: made.data.id, sleep };
}

describe("warden perf-collect", () => {
	test("records itself as the collector and stops the session at its cap", async () => {
		const { c, deps, id, sleep } = setup(3_000);
		c.argv = ["--session", id];
		const command = createPerfCollectCommand({ sleep, session: deps.session });
		expect(await command.run(c)).toBe(0);
		const s = readSession(c, id);
		expect(s).toMatchObject({ status: "stopped", stopReason: "max-duration" });
		expect(s?.capturers).toEqual([
			{ kind: "collector", pid: process.pid, startedAtIso: new Date(T0).toISOString(), state: "stopped" },
		]);
	});

	test("a missing or malformed session is exit 1", async () => {
		const { c, deps, sleep } = setup(3_000);
		const command = createPerfCollectCommand({ sleep, session: deps.session });
		c.argv = ["--session", "nope"];
		expect(await command.run(c)).toBe(1);
		c.argv = ["--session", "20000101-000000-abcdef"];
		expect(await command.run(c)).toBe(1);
		c.argv = [];
		expect(await command.run(c)).toBe(1);
	});

	test("a session that already stopped is exit 1 and is left untouched", async () => {
		const { c, deps, id, sleep } = setup(3_000);
		stopSession(c, deps.session, id, "user", { signalCollector: false });
		c.argv = ["--session", id];
		const command = createPerfCollectCommand({ sleep, session: deps.session });
		expect(await command.run(c)).toBe(1);
		expect(readSession(c, id)).toMatchObject({ stopReason: "user", capturers: [] });
		expect(c.stderr.join("\n")).toContain(`no running perf session ${id}`);
	});

	test("is hidden from --help", () => {
		expect(createPerfCollectCommand().hidden).toBe(true);
	});
});

describe("warden perf-collect with a plan", () => {
	const EMU = "emulator-5554";
	const APP = "com.acme.shop";
	const TOP = " 4321 u0_a123      10 -10  14G 250M 120M S  25.0   6.5   0:30.11 com.acme.shop\n";

	function planned(maxDurationMs: number) {
		const clock = { now: T0 };
		const c = testContext([], {
			now: () => clock.now,
			exec: async (cmd) => {
				const line = cmd.join(" ");
				if (line.includes("pidof")) return { exitCode: 0, stdout: "4321\n", stderr: "" };
				if (line.includes("shell top")) return { exitCode: 0, stdout: TOP, stderr: "" };
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		ctx = c;
		const deps = fakePerfDeps([{ platform: "android", id: EMU, name: "pixel" }]);
		const made = createSession(c, deps.session, {
			device: { udid: EMU, platform: "android", name: "pixel" },
			target: { udid: EMU, ownedByCaller: false },
			app: { id: APP, source: "flag" },
			maxDurationMs,
		});
		if (!made.success) throw new Error("create");
		writePlan(c, made.data.id, {
			version: 1,
			app: APP,
			cwd: "/app",
			metrics: true,
			frames: false,
			logs: false,
			js: false,
			react: false,
			relaunch: false,
		});
		const hooks = { onSleep: (_n: number) => {} };
		let sleeps = 0;
		const sleep = async (ms: number) => {
			sleeps++;
			clock.now += ms;
			hooks.onSleep(sleeps);
			await Bun.sleep(0);
		};
		const kit: SessionKit = {
			io: {
				spawnDetached: () => ({ pid: 1 }),
				kill: () => {},
				pidAlive: () => false,
				sleep: async () => {},
				self: () => ["warden"],
			},
			profilers: {
				ios: async () => {
					throw new Error("no native profiler expected");
				},
				android: async () => {
					throw new Error("no native profiler expected");
				},
			},
		};
		const collector = {
			sleep,
			js: {
				open: async () =>
					ok({ send: async () => ({ success: true as const, data: {} }), onCdp: () => () => {}, close: () => {} }),
				fetchMap: async () => jsOk(""),
				sleep,
			},
		};
		return { c, clock, deps, id: made.data.id, kit, collector, hooks };
	}

	test("hosts the collector, then at the cap runs the stop path: session stopped max-duration with a report", async () => {
		const { c, deps, id, kit, collector } = planned(3_000);
		c.argv = ["--session", id];
		const command = createPerfCollectCommand({ perf: deps, kit, collector, session: deps.session });
		expect(await command.run(c)).toBe(0);
		expect(readSession(c, id)).toMatchObject({ status: "stopped", stopReason: "max-duration" });
		expect(existsSync(join(sessionDir(c, id), "metrics", "samples.jsonl"))).toBe(true);
		expect(existsSync(join(sessionDir(c, id), "report.json"))).toBe(true);
		const kinds = readSession(c, id)
			?.capturers.map((x) => x.kind)
			.sort();
		expect(kinds).toEqual(["collector", "metrics"]);
		expect(deps.session.killed).toEqual([]);
	});

	test("an abort signal (SIGTERM) exits 0 with the captures flushed and leaves the stop to `perf stop`", async () => {
		const { c, deps, id, kit, collector, hooks } = planned(120_000);
		const stop = new AbortController();
		hooks.onSleep = (n) => {
			if (n === 4) stop.abort();
		};
		c.argv = ["--session", id];
		const command = createPerfCollectCommand({
			perf: deps,
			kit,
			collector,
			session: deps.session,
			signal: stop.signal,
		});
		expect(await command.run(c)).toBe(0);
		expect(readSession(c, id)).toMatchObject({ status: "running" });
		expect(readSession(c, id)?.capturers.find((x) => x.kind === "metrics")?.state).toBe("stopped");
		expect(existsSync(join(sessionDir(c, id), "report.json"))).toBe(false);
	});
});
