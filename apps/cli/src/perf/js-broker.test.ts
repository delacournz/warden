import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hotspots } from "@delacour/warden-perf/js/hotspots";
import { ok } from "@delacour/warden-types/result";
import { brokerErr } from "../dev-broker/broker.types";
import { type BrokerServer, serveBroker } from "../dev-broker/ipc";
import { writeDevSession } from "../dev-session";
import { type TestContext, testContext } from "../testing";
import { perfJs } from "./js";
import type { JsDeps } from "./js-capture";
import { asMe, fakePerfDeps } from "./testing";

const cleanup: Array<() => unknown> = [];
let ctx: TestContext | undefined;
afterEach(async () => {
	ctx?.cleanup();
	for (const fn of cleanup.splice(0)) await fn();
});

const T0 = Date.UTC(2026, 9, 27, 10, 0, 0);
const sim = { platform: "ios", id: "U1", name: "warden-iphone-17-1" } as const;

const hotspots: Hotspots = {
	version: 1,
	durationMs: 600,
	sampleCount: 3,
	idleMs: 300,
	idlePct: 50,
	programMs: 0,
	gcMs: 0,
	activeMs: 300,
	topSelf: [
		{
			name: "renderFeed",
			file: "src/Feed.tsx",
			line: 12,
			column: 0,
			mapped: true,
			selfMs: 300,
			totalMs: 300,
			selfPct: 100,
			totalPct: 100,
		},
	],
	topTotal: [],
	packages: [],
	unmappedPct: 0,
	warnings: [],
};

describe("warden perf js with a dev-session broker", () => {
	test("profiles through profile.start/stop and reports from hotspots.json; opens no Hermes socket", async () => {
		const c = testContext([], { now: () => T0 });
		ctx = c;
		asMe(c);
		c.db.recordDevice({ platform: "ios", id: "U1", name: sim.name }, T0);
		const dir = mkdtempSync(join(tmpdir(), "wpj-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const profileDir = join(dir, "profiles", "cpu-x");
		mkdirSync(profileDir, { recursive: true });
		const cpuPath = join(profileDir, "cpu.cpuprofile");
		const hotspotsPath = join(profileDir, "hotspots.json");
		writeFileSync(cpuPath, "{}");
		writeFileSync(hotspotsPath, JSON.stringify(hotspots));

		const calls: Array<{ method: string; params: unknown }> = [];
		const served = await serveBroker(join(dir, "b.sock"), async (method, params) => {
			calls.push({ method, params });
			if (method === "status") return ok({});
			if (method === "profile.start") return ok({ kind: "cpu", startedAt: T0 });
			if (method === "profile.stop") {
				return ok({
					kind: "cpu",
					path: cpuPath,
					summary: { kind: "cpu", sampleCount: 3, durationMs: 600, idlePct: 50, hotspotsPath, topSelf: [] },
				});
			}
			return brokerErr("unknown_method", method);
		});
		if (!served.success) throw new Error(served.error.message);
		const server: BrokerServer = served.data;
		cleanup.push(() => server.close());
		writeDevSession(c.env, {
			version: 1,
			leaseId: "lease-1",
			pid: process.pid,
			platform: "ios",
			deviceId: "U1",
			port: 8081,
			metroUrl: "http://127.0.0.1:8081",
			logDir: dir,
			projectRoot: "/p",
			startedAt: "2026-10-27T00:00:00.000Z",
			brokerSocket: server.socketPath,
		});

		const deps = fakePerfDeps([sim], { U1: "com.acme.shop" }, { metro: async () => "http://127.0.0.1:8081" });
		const slept: number[] = [];
		let opened = 0;
		const js: JsDeps = {
			open: async () => {
				opened++;
				return { success: false, error: { code: "devtools_unavailable", message: "no direct socket" } };
			},
			fetchMap: async () => ({ success: false, error: { code: "cdp_failed", message: "unused" } }),
			sleep: async (ms) => {
				slept.push(ms);
			},
		};

		expect(
			await perfJs(c, deps, { json: true, app: "com.acme.shop", duration: "5s", samplingInterval: "200" }, js)
		).toBe(0);
		const doc = JSON.parse(c.stdout.join("\n"));
		expect(doc).toMatchObject({ ok: true, command: "perf js", result: { app: "com.acme.shop" } });
		expect(doc.result.files).toEqual({ cpuprofile: cpuPath, hotspots: hotspotsPath });
		expect(doc.result.hotspots.topSelf[0]).toMatchObject({ name: "renderFeed", line: 12 });
		expect(calls).toEqual([
			{ method: "profile.start", params: { kind: "cpu", samplingIntervalUs: 200 } },
			{ method: "profile.stop", params: { kind: "cpu" } },
		]);
		expect(slept).toEqual([5_000]);
		expect(opened).toBe(0);
	});
});
