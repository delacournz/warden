import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FakeCdpRequest,
	type FakeMetro,
	type FakeReply,
	startFakeMetro,
} from "@delacour/warden-e2e/devtools/devtools.testing";
import { buildProfile } from "@delacour/warden-perf/js/js.testing";
import { jsErr } from "@delacour/warden-perf/js/js.types";
import { fakeGlobal, fakeHook, fakeRenderer } from "@delacour/warden-perf/react/react.testing";
import { type Broker, callBroker, startBroker } from "./broker";
import { withExtensions } from "./extensions";
import { profileStatus, startProfile, stopProfile } from "./profile-client";
import { createProfilesExtension, summarizeHeapSampling } from "./profiles";

const dirs: string[] = [];
const brokers: Broker[] = [];
const metros: FakeMetro[] = [];

afterEach(async () => {
	for (const broker of brokers.splice(0)) await broker.close();
	for (const metro of metros.splice(0)) await metro.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const T0 = Date.UTC(2026, 9, 27, 10, 0, 0);
const CPU = buildProfile(
	[
		{ id: 1, name: "(root)", children: [2, 3] },
		{ id: 2, name: "renderFeed", url: "http://m/index.bundle" },
		{ id: 3, name: "(idle)" },
	],
	[
		[2, 0],
		[2, 300_000],
		[3, 300_000],
	]
);

const HEAP = {
	head: {
		callFrame: { functionName: "(root)", url: "" },
		selfSize: 0,
		children: [
			{ callFrame: { functionName: "makeRows", url: "http://m/a.js", lineNumber: 9 }, selfSize: 600 },
			{ callFrame: { functionName: "makeRows", url: "http://m/a.js", lineNumber: 9 }, selfSize: 200 },
			{ callFrame: { functionName: "parse", url: "http://m/b.js", lineNumber: 0 }, selfSize: 200 },
		],
	},
	samples: [],
};

/** An app behind the fake Metro: Hermes Profiler/HeapProfiler answers, and the React profiler script run in-process. */
function app(options: { heapFails?: boolean }) {
	const g = fakeGlobal(fakeHook([fakeRenderer()]));
	return (request: FakeCdpRequest): FakeReply | undefined => {
		switch (request.method) {
			case "Profiler.stop":
				return { result: { profile: CPU } };
			case "HeapProfiler.startSampling":
				return options.heapFails ? { error: { message: "'HeapProfiler.startSampling' wasn't found" } } : { result: {} };
			case "HeapProfiler.stopSampling":
				return { result: { profile: HEAP } };
			case "Runtime.evaluate": {
				try {
					const value = new Function("globalThis", `return ${String(request.params.expression)};`)(g);
					return { result: { result: { value } } };
				} catch (error) {
					return { error: { message: String(error) } };
				}
			}
			default:
				return undefined;
		}
	};
}

async function setup(options: { heapFails?: boolean } = {}) {
	const metro = startFakeMetro({ respond: app(options) });
	metros.push(metro);
	const logDir = mkdtempSync(join(tmpdir(), "wbp-"));
	dirs.push(logDir);
	const started = await startBroker({
		metroUrl: metro.url,
		device: { deviceName: "iPhone A" },
		logDir,
		retry: { initialMs: 10, maxMs: 20 },
		networkPollMs: 10,
	});
	if (!started.success) throw new Error(started.error.message);
	const broker = withExtensions(started.data, { metroUrl: metro.url, logDir }, [
		createProfilesExtension({
			now: () => T0,
			cwd: logDir,
			fetchMap: async () => jsErr("cdp_failed", "no source maps in this test"),
		}),
	]);
	brokers.push(broker);
	await until(() => broker.state().phase === "attached", "attached");
	return { broker, metro, logDir };
}

const call = (broker: Broker, method: string, params: unknown) => callBroker(broker.socketPath, { method, params });

describe("profile.* methods", () => {
	test("cpu: start, stop writes the cpuprofile and hotspots and returns top self-time functions", async () => {
		const { broker, metro, logDir } = await setup();
		const started = await call(broker, "profile.start", { kind: "cpu", samplingIntervalUs: 50 });
		expect(started.success && started.data).toEqual({ kind: "cpu", startedAt: T0 });
		expect(metro.requests.some((r) => r.method === "Profiler.setSamplingInterval" && r.params.interval === 50)).toBe(
			true
		);
		const status = await call(broker, "profile.status", {});
		expect(status.success && status.data).toEqual({ active: [{ kind: "cpu", startedAt: T0 }] });

		const stopped = await call(broker, "profile.stop", { kind: "cpu" });
		if (!stopped.success) throw new Error(stopped.error.message);
		const data = stopped.data as import("./profile-client").ProfileStopData;
		expect(data.path.startsWith(join(logDir, "profiles", "cpu-"))).toBe(true);
		expect(existsSync(data.path)).toBe(true);
		expect(data.summary.kind).toBe("cpu");
		if (data.summary.kind !== "cpu") return;
		expect(data.summary.topSelf[0]?.name).toBe("renderFeed");
		expect(existsSync(data.summary.hotspotsPath)).toBe(true);
		const after = await call(broker, "profile.status", {});
		expect(after.success && after.data).toEqual({ active: [] });
	});

	test("heap: sampling is written and summarised by allocation site", async () => {
		const { broker, metro } = await setup();
		expect((await call(broker, "profile.start", { kind: "heap" })).success).toBe(true);
		const stopped = await call(broker, "profile.stop", { kind: "heap" });
		if (!stopped.success) throw new Error(stopped.error.message);
		const data = stopped.data as import("./profile-client").ProfileStopData;
		expect(data.path.endsWith("heap.heapsampling")).toBe(true);
		expect(JSON.parse(readFileSync(data.path, "utf8")).head.children).toHaveLength(3);
		expect(data.summary).toMatchObject({
			kind: "heap",
			totalBytes: 1000,
			topAllocators: [
				{ name: "makeRows", file: "http://m/a.js", line: 10, selfBytes: 800, pct: 80 },
				{ name: "parse", selfBytes: 200, pct: 20 },
			],
		});
		expect(metro.connections).toHaveLength(1);
	});

	test("react: start and stop write commits.json with the slowest commits and components", async () => {
		const { broker } = await setup();
		const started = await call(broker, "profile.start", { kind: "react" });
		if (!started.success) throw new Error(started.error.message);
		const stopped = await call(broker, "profile.stop", { kind: "react" });
		if (!stopped.success) throw new Error(stopped.error.message);
		const data = stopped.data as import("./profile-client").ProfileStopData;
		expect(data.path.endsWith("commits.json")).toBe(true);
		expect(existsSync(data.path)).toBe(true);
		expect(data.summary.kind).toBe("react");
		if (data.summary.kind !== "react") return;
		expect(data.summary.commits).toBe(2);
		expect(data.summary.slowestCommits.length).toBe(1);
		expect(existsSync(data.summary.findingsPath)).toBe(true);
	});

	test("stop without start, double start and bad params are bad_request; unsupported heap is cdp_protocol", async () => {
		const { broker } = await setup({ heapFails: true });
		const none = await call(broker, "profile.stop", { kind: "cpu" });
		expect(!none.success && none.error.code).toBe("bad_request");
		const bad = await call(broker, "profile.start", { kind: "gpu" });
		expect(!bad.success && bad.error.code).toBe("bad_request");
		const heap = await call(broker, "profile.start", { kind: "heap" });
		expect(!heap.success && heap.error.code).toBe("cdp_protocol");
		expect((await call(broker, "profile.start", { kind: "cpu" })).success).toBe(true);
		const twice = await call(broker, "profile.start", { kind: "cpu" });
		expect(!twice.success && twice.error.code).toBe("bad_request");
	});

	test("a reconnect forgets recordings (the runtime lost them)", async () => {
		const { broker, metro } = await setup();
		await call(broker, "profile.start", { kind: "heap" });
		const before = metro.connections[0]?.id;
		metro.dropAll();
		await until(() => metro.connections.length === 1 && metro.connections[0]?.id !== before, "re-attached");
		let active = 1;
		await until(() => {
			void call(broker, "profile.status", {}).then((r) => {
				active = r.success ? (r.data as { active: unknown[] }).active.length : -1;
			});
			return active === 0;
		}, "recordings forgotten");
	});
});

describe("profile client", () => {
	test("startProfile and stopProfile find the session's broker socket and forward the call", async () => {
		const calls: Array<{ socket: string; method: string; params: unknown }> = [];
		const { writeDevSession } = await import("../dev-session");
		const home = mkdtempSync(join(tmpdir(), "wbh-"));
		dirs.push(home);
		const env = { WARDEN_HOME: home };
		writeDevSession(env, {
			version: 1,
			leaseId: "L1",
			pid: process.pid,
			platform: "ios",
			deviceId: "U1",
			port: 8081,
			metroUrl: "http://127.0.0.1:8081",
			logDir: home,
			projectRoot: home,
			startedAt: "2026-10-27T10:00:00Z",
			brokerSocket: "/tmp/b.sock",
		});
		const deps = {
			call: async (socket: string, request: { method: string; params?: unknown }) => {
				calls.push({ socket, method: request.method, params: request.params });
				return { success: true as const, data: { kind: "cpu", startedAt: 1 } };
			},
		};
		const started = await startProfile(env, { udid: "U1", kind: "cpu", samplingIntervalUs: 200 }, deps);
		expect(started.success).toBe(true);
		await stopProfile(env, { kind: "cpu" }, deps);
		await profileStatus(env, {}, deps);
		expect(calls).toEqual([
			{ socket: "/tmp/b.sock", method: "profile.start", params: { kind: "cpu", samplingIntervalUs: 200 } },
			{ socket: "/tmp/b.sock", method: "profile.stop", params: { kind: "cpu" } },
			{ socket: "/tmp/b.sock", method: "profile.status", params: {} },
		]);
		const none = await startProfile({ WARDEN_HOME: join(home, "empty") }, { kind: "cpu" }, deps);
		expect(!none.success && none.error.code).toBe("broker_unreachable");
	});
});

describe("summarizeHeapSampling", () => {
	test("merges sites and ranks by bytes", () => {
		const summary = summarizeHeapSampling(HEAP.head, 1);
		expect(summary.topAllocators).toHaveLength(1);
		expect(summary.topAllocators[0]?.selfBytes).toBe(800);
	});
});
