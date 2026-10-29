import { afterEach, describe, expect, test } from "bun:test";
import { activeConditions, recordCondition } from "@delacour/warden-core/conditions/conditions";
import type { ProxyStatus } from "@delacour/warden-core/netproxy/control";
import type { TickerConfig } from "@delacour/warden-e2e/conditions/route-ticker";
import type { SchedulerConfig } from "@delacour/warden-e2e/conditions/scheduler.config";
import { failWith, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { ok } from "@delacour/warden-types/result";
import { updateState } from "../agent-ui/state";
import { cleanupHarnesses, doc, type Harness, harness, LOGIN, UDID } from "./ui.testing";

afterEach(cleanupHarnesses);

const STATS = { connections: 4, resets: 1, stalls: 0, faulted: 2, bytesUp: 0, bytesDown: 0 };

type Setup = {
	h: Harness;
	killed: number[];
	schedulers: SchedulerConfig[];
	tickers: TickerConfig[];
	/** pids the fake process table considers alive */
	alive: Set<number>;
	proxy: { status?: ProxyStatus & { port: number }; pid?: number };
	ensured: number[];
	/** the options each `network` call carried */
	networkOptions: unknown[];
};

function setup(platform: "ios" | "android" = "ios"): Setup {
	const killed: number[] = [];
	const schedulers: SchedulerConfig[] = [];
	const tickers: TickerConfig[] = [];
	const alive = new Set<number>();
	const proxy: Setup["proxy"] = {};
	const ensured: number[] = [];
	let nextPid = 900;
	const networkOptions: unknown[] = [];
	const s = { killed, schedulers, tickers, alive, proxy, ensured, networkOptions } as Setup;
	s.h = harness([snapshotOf(LOGIN)], {
		platform,
		pidAlive: (pid) => alive.has(pid),
		conditions: {
			open: async () =>
				ok({
					network: (op, opts) => {
						networkOptions.push(opts);
						return s.h.driver.network(op, opts);
					},
					networkFaults: (faults) => s.h.driver.networkFaults(faults),
					location: (op) => s.h.driver.location(op),
					close: () => s.h.driver.close(),
				}),
			spawnScheduler: (config) => {
				schedulers.push(config);
				alive.add(nextPid);
				return ok({ kind: "pid", pid: nextPid++ });
			},
			spawnTicker: (config) => {
				tickers.push(config);
				alive.add(nextPid);
				return ok({ kind: "pid", pid: nextPid++ });
			},
			kill: (pid) => {
				killed.push(pid);
				alive.delete(pid);
			},
			proxyStatus: async () => proxy.status,
			proxyPid: () => proxy.pid,
			command: undefined as never,
			adb: () => "/fake/adb",
			ensureProxy: async () => {
				ensured.push(1);
				return ok(undefined);
			},
		},
	});
	return s;
}

const lease = (s: Setup) => s.h.c.store().listLeases()[0]?.id as string;
const stored = (s: Setup, area: "network" | "location") =>
	activeConditions(s.h.c.store(), lease(s)).find((r) => r.area === area);

describe("net <condition>", () => {
	test("a preset: one driver call, recorded on the lease", async () => {
		const s = setup();
		expect(await s.h.run("net", "3g", "--json")).toBe(0);
		expect(s.h.driver.callsOf("network")).toEqual([{ method: "network", op: { kind: "preset", preset: "3g" } }]);
		expect(doc(s.h.c)).toMatchObject({
			ok: true,
			command: "net",
			result: { action: "net", condition: { kind: "preset", preset: "3g" } },
		});
		expect(stored(s, "network")?.value).toEqual({ kind: "preset", preset: "3g" });
	});

	test("flags override a preset and become a custom condition", async () => {
		const s = setup();
		expect(await s.h.run("net", "3g", "--latency", "800", "--loss", "5")).toBe(0);
		expect(s.h.driver.callsOf("network")[0]?.op).toMatchObject({
			kind: "custom",
			latencyMs: 800,
			lossPct: 5,
			downKbps: 780,
		});
	});

	test("online with nothing set records nothing", async () => {
		const s = setup();
		expect(await s.h.run("net", "online")).toBe(0);
		expect(stored(s, "network")).toBeUndefined();
	});

	test("offline then online keeps a row, so release has something to undo", async () => {
		const s = setup();
		await s.h.run("net", "offline");
		await s.h.run("net", "online");
		expect(stored(s, "network")?.value).toEqual({ kind: "online" });
	});

	test("the app warden ui opened is passed so iOS can check it for the dylib", async () => {
		const s = setup();
		updateState(s.h.c, UDID, (st) => ({ ...st, app: "com.example.app" }));
		expect(await s.h.run("net", "offline", "--relaunch")).toBe(0);
		expect(s.networkOptions).toEqual([{ bundleId: "com.example.app", relaunch: true }]);
	});

	test("E_NETWORK_RELAUNCH is reported verbatim and nothing is recorded", async () => {
		const failing = harness([snapshotOf(LOGIN)], {
			onCall: (call) =>
				call.method === "network" ? failWith("E_NETWORK_RELAUNCH", "app runs without the dylib") : undefined,
			conditions: {
				open: async () => ok(failing.driver),
				proxyStatus: async () => undefined,
				proxyPid: () => undefined,
			},
		});
		expect(await failing.run("net", "offline", "--json")).toBe(1);
		const out = doc(failing.c);
		expect(out.error.message).toContain("E_NETWORK_RELAUNCH");
		expect(out.error.details).toEqual({ driver: "E_NETWORK_RELAUNCH" });
		expect(activeConditions(failing.c.store(), failing.c.store().listLeases()[0]?.id as string)).toEqual([]);
	});

	test("E_UNSUPPORTED (a physical device) is reported verbatim", async () => {
		const failing = harness([snapshotOf(LOGIN)], {
			onCall: (call) =>
				call.method === "network" ? failWith("E_UNSUPPORTED", "network needs an emulator") : undefined,
			conditions: {
				open: async () => ok(failing.driver),
				proxyStatus: async () => undefined,
				proxyPid: () => undefined,
			},
		});
		expect(await failing.run("net", "3g", "--json")).toBe(1);
		expect(doc(failing.c).error.message).toContain("E_UNSUPPORTED");
	});

	test.each([
		[["net", "dialup"], "unknown network"],
		[["net", "offline", "--latency", "10"], "no shaping flags"],
		[["net", "3g", "extra"], "unexpected argument"],
		[["net", "3g", "--loss", "400"], "--loss"],
	])("usage: %j", async (argv, text) => {
		const s = setup();
		expect(await s.h.run(...argv, "--json")).toBe(1);
		const out = doc(s.h.c);
		expect(out.error.code).toBe("usage");
		expect(out.error.message + (out.error.hint ?? "")).toContain(text);
		expect(s.h.driver.callsOf("network")).toHaveLength(0);
	});

	test("faults already on the proxy are put back before the new condition", async () => {
		const s = setup();
		s.proxy.status = {
			params: {},
			faults: [{ match: "api.*", action: { kind: "status", code: 503 } }],
			pid: 5,
			stats: STATS,
			port: 19080,
		};
		expect(await s.h.run("net", "4g")).toBe(0);
		expect(s.h.driver.calls.map((c) => c.method).filter((m) => m === "networkFaults" || m === "network")).toEqual([
			"networkFaults",
			"network",
		]);
	});

	test("a running flap is stopped first and its pid is dropped from the lease", async () => {
		const s = setup();
		s.alive.add(777);
		recordCondition(s.h.c.store(), lease(s), "network", { kind: "flap", upMs: 1000, downMs: 500 }, 1, [
			{ kind: "pid", pid: 777 },
		]);
		expect(await s.h.run("net", "offline")).toBe(0);
		expect(s.killed).toEqual([777]);
		expect(stored(s, "network")?.owned).toEqual([]);
	});

	test("the lease's proxy pid stays owned", async () => {
		const s = setup();
		s.proxy.pid = 4242;
		await s.h.run("net", "lossy");
		expect(stored(s, "network")?.owned).toEqual([{ kind: "pid", pid: 4242 }]);
	});
});

describe("net flap", () => {
	test("Android: starts a detached scheduler and records it as owned", async () => {
		const s = setup("android");
		expect(await s.h.run("net", "flap", "--up", "10s", "--down", "3s", "--jitter", "20", "--seed", "4", "--json")).toBe(
			0
		);
		expect(s.schedulers).toEqual([
			{
				platform: "android",
				id: UDID,
				mode: "flap",
				adb: "/fake/adb",
				flap: { upMs: 10_000, downMs: 3_000, base: { kind: "online" }, applyInitial: false, jitterPct: 20, seed: 4 },
			},
		]);
		expect(s.h.driver.callsOf("network").map((c) => c.op)).toEqual([{ kind: "online" }]);
		const record = stored(s, "network");
		expect(record?.value).toMatchObject({ kind: "flap", upMs: 10_000, downMs: 3_000, jitterPct: 20 });
		expect(record?.owned).toEqual([{ kind: "pid", pid: 900 }]);
		expect(doc(s.h.c).result).toMatchObject({ action: "net-flap", pid: 900 });
	});

	test("iOS: the proxy is up first and the lease rides along", async () => {
		const s = setup("ios");
		expect(await s.h.run("net", "flap", "--up", "5s", "--down", "1s")).toBe(0);
		expect(s.ensured).toHaveLength(1);
		const config = s.schedulers[0];
		expect(config?.platform).toBe("ios");
		expect(config?.lease).toMatchObject({ id: lease(s) });
	});

	test("replaces a previous flap: the old scheduler is stopped", async () => {
		const s = setup("android");
		await s.h.run("net", "flap", "--up", "10s", "--down", "3s");
		await s.h.run("net", "flap", "--up", "2s", "--down", "1s");
		expect(s.killed).toEqual([900]);
		expect(stored(s, "network")?.owned).toEqual([{ kind: "pid", pid: 901 }]);
	});

	test("needs --up and --down", async () => {
		const s = setup("android");
		expect(await s.h.run("net", "flap", "--up", "10s", "--json")).toBe(1);
		expect(doc(s.h.c).error.code).toBe("usage");
		expect(s.schedulers).toHaveLength(0);
	});

	test("refuses while faults are set", async () => {
		const s = setup("android");
		s.proxy.status = { params: {}, faults: [{ match: "*", action: { kind: "reset" } }], pid: 5, stats: STATS, port: 1 };
		expect(await s.h.run("net", "flap", "--up", "1s", "--down", "1s")).toBe(1);
		expect(s.schedulers).toHaveLength(0);
	});
});

describe("net fault", () => {
	test("sets a rule and warns about https for a status", async () => {
		const s = setup();
		expect(await s.h.run("net", "fault", "api.example.com", "status:503", "--json")).toBe(0);
		expect(s.h.driver.callsOf("networkFaults")[0]?.faults).toEqual([
			{ match: "api.example.com", action: { kind: "status", code: 503 } },
		]);
		const out = doc(s.h.c);
		expect(out.result.faults).toHaveLength(1);
		expect(out.warnings?.[0]).toContain("https://");
	});

	test("adds to the faults on the proxy; the same glob replaces", async () => {
		const s = setup();
		s.proxy.status = {
			params: {},
			faults: [
				{ match: "a.*", action: { kind: "reset" } },
				{ match: "b.*", action: { kind: "blackhole" } },
			],
			pid: 5,
			stats: STATS,
			port: 1,
		};
		await s.h.run("net", "fault", "a.*", "delay:2s");
		expect(s.h.driver.callsOf("networkFaults")[0]?.faults).toEqual([
			{ match: "b.*", action: { kind: "blackhole" } },
			{ match: "a.*", action: { kind: "delay", ms: 2000 } },
		]);
	});

	test("re-applies the recorded condition so the driver keeps it", async () => {
		const s = setup();
		await s.h.run("net", "3g");
		s.h.driver.calls.length = 0;
		await s.h.run("net", "fault", "x", "reset");
		expect(s.h.driver.calls.map((c) => c.method).filter((m) => m === "networkFaults" || m === "network")).toEqual([
			"network",
			"networkFaults",
		]);
	});

	test("--clear removes every fault", async () => {
		const s = setup();
		s.proxy.status = { params: {}, faults: [{ match: "a", action: { kind: "reset" } }], pid: 5, stats: STATS, port: 1 };
		expect(await s.h.run("net", "fault", "--clear")).toBe(0);
		expect(s.h.driver.callsOf("networkFaults")[0]?.faults).toEqual([]);
	});

	test.each([
		[["net", "fault", "only-host"]],
		[["net", "fault", "h", "status:99"]],
		[["net", "fault", "h", "nope"]],
		[["net", "fault", "--clear", "h"]],
	])("usage: %j", async (argv) => {
		const s = setup();
		expect(await s.h.run(...argv, "--json")).toBe(1);
		expect(doc(s.h.c).error.code).toBe("usage");
		expect(s.h.driver.callsOf("networkFaults")).toHaveLength(0);
	});

	test("refuses while a flap runs", async () => {
		const s = setup();
		recordCondition(s.h.c.store(), lease(s), "network", { kind: "flap", upMs: 1000, downMs: 500 }, 1, []);
		expect(await s.h.run("net", "fault", "h", "reset")).toBe(1);
		expect(s.h.driver.callsOf("networkFaults")).toHaveLength(0);
	});
});

describe("net status / reset", () => {
	test("status reads the lease, the proxy and the flap pid without opening a driver", async () => {
		const s = setup("android");
		await s.h.run("net", "flap", "--up", "10s", "--down", "3s");
		s.proxy.status = {
			params: {},
			faults: [{ match: "a", action: { kind: "status", code: 500 } }],
			pid: 5,
			stats: STATS,
			port: 19081,
		};
		s.h.opens.count = 0;
		expect(await s.h.run("net", "status", "--json")).toBe(0);
		expect(s.h.opens.count).toBe(0);
		const out = doc(s.h.c).result;
		expect(out).toMatchObject({
			action: "net-status",
			condition: { kind: "flap" },
			flap: { pid: 900, running: true },
			proxy: { port: 19081 },
		});
		expect(out.faults).toHaveLength(1);
	});

	test("status of a lease with nothing set", async () => {
		const s = setup();
		expect(await s.h.run("net", "status")).toBe(0);
		expect(s.h.c.stdout.join("\n")).toContain("not set");
	});

	test("reset stops the flap, clears faults and goes online, keeping the proxy for an injected app", async () => {
		const s = setup("android");
		await s.h.run("net", "flap", "--up", "10s", "--down", "3s");
		s.proxy.status = { params: {}, faults: [{ match: "a", action: { kind: "reset" } }], pid: 5, stats: STATS, port: 1 };
		s.h.driver.calls.length = 0;
		expect(await s.h.run("net", "reset")).toBe(0);
		expect(s.killed).toEqual([900]);
		expect(s.h.driver.calls.map((c) => c.method).filter((m) => m === "networkFaults" || m === "network")).toEqual([
			"networkFaults",
			"network",
		]);
		expect(s.h.driver.callsOf("networkFaults")[0]?.faults).toEqual([]);
		expect(stored(s, "network")?.value).toEqual({ kind: "online" });
		expect(stored(s, "network")?.owned).toEqual([]);
	});

	test("reset with nothing set does not open the device", async () => {
		const s = setup();
		expect(await s.h.run("net", "reset", "--json")).toBe(0);
		expect(s.h.opens.count).toBe(0);
		expect(doc(s.h.c).result).toMatchObject({ changed: false });
	});
});

describe("location", () => {
	test("set: a point, recorded", async () => {
		const s = setup();
		expect(await s.h.run("location", "set", "37.33,-122.03", "--alt", "12", "--json")).toBe(0);
		expect(s.h.driver.callsOf("location")[0]?.op).toEqual({ kind: "point", lat: 37.33, lon: -122.03, altM: 12 });
		expect(stored(s, "location")?.value).toMatchObject({ kind: "point", lat: 37.33 });
	});

	test("iOS route: simctl plays it, nothing is spawned", async () => {
		const s = setup("ios");
		expect(await s.h.run("location", "route", "0,0", "0,0.01", "--speed", "5", "--interval", "2")).toBe(0);
		expect(s.h.driver.callsOf("location")[0]?.op).toEqual({
			kind: "route",
			points: [
				{ lat: 0, lon: 0 },
				{ lat: 0, lon: 0.01 },
			],
			speedMps: 5,
			intervalS: 2,
		});
		expect(s.tickers).toHaveLength(0);
		expect(stored(s, "location")?.owned).toEqual([]);
	});

	test("iOS --loop is the driver's E_UNSUPPORTED, verbatim", async () => {
		const h = harness([snapshotOf(LOGIN)], {
			onCall: (call) =>
				call.method === "location" ? failWith("E_UNSUPPORTED", "simctl location has no loop") : undefined,
			conditions: { open: async () => ok(h.driver), proxyStatus: async () => undefined, proxyPid: () => undefined },
		});
		expect(await h.run("location", "route", "0,0", "1,1", "--loop", "--json")).toBe(1);
		expect(doc(h.c).error.message).toContain("E_UNSUPPORTED");
	});

	test("Android route: first fix, then a detached ticker the lease owns", async () => {
		const s = setup("android");
		expect(await s.h.run("location", "route", "0,0", "0,0.01", "--speed", "4", "--loop", "--json")).toBe(0);
		expect(s.h.driver.callsOf("location")[0]?.op).toEqual({ kind: "point", lat: 0, lon: 0 });
		expect(s.tickers).toEqual([
			{
				adb: "/fake/adb",
				serial: UDID,
				points: [
					{ lat: 0, lon: 0 },
					{ lat: 0, lon: 0.01 },
				],
				speedMps: 4,
				intervalS: 1,
				loop: true,
			},
		]);
		expect(stored(s, "location")?.owned).toEqual([{ kind: "pid", pid: 900 }]);
		expect(doc(s.h.c).result).toMatchObject({ action: "location-route", pid: 900, loop: true });
	});

	test("Android scenario plays the bundled route", async () => {
		const s = setup("android");
		expect(await s.h.run("location", "scenario", "freeway")).toBe(0);
		expect(s.tickers).toHaveLength(1);
		expect(s.tickers[0]?.points.length).toBeGreaterThan(1);
		expect(stored(s, "location")?.value).toEqual({ kind: "scenario", name: "freeway" });
	});

	test("a new location stops the previous ticker", async () => {
		const s = setup("android");
		await s.h.run("location", "scenario", "city-run");
		await s.h.run("location", "set", "1,2");
		expect(s.killed).toEqual([900]);
		expect(stored(s, "location")?.owned).toEqual([]);
	});

	test("iOS scenario and gpx go to the driver", async () => {
		const s = setup("ios");
		await s.h.run("location", "scenario", "city-bike");
		await s.h.run("location", "gpx", "run.gpx", "--speed", "3");
		expect(s.h.driver.callsOf("location").map((c) => c.op)).toEqual([
			{ kind: "scenario", name: "city-bike" },
			{ kind: "gpx", path: `${s.h.c.cwd}/run.gpx`, speedMps: 3 },
		]);
	});

	test("clear stops the ticker and forgets the condition", async () => {
		const s = setup("android");
		await s.h.run("location", "scenario", "city-run");
		expect(await s.h.run("location", "clear", "--json")).toBe(0);
		expect(s.killed).toEqual([900]);
		expect(stored(s, "location")).toBeUndefined();
		expect(doc(s.h.c).result).toMatchObject({ cleared: true });
	});

	test("status", async () => {
		const s = setup("android");
		await s.h.run("location", "scenario", "city-run");
		s.h.opens.count = 0;
		expect(await s.h.run("location", "status", "--json")).toBe(0);
		expect(s.h.opens.count).toBe(0);
		expect(doc(s.h.c).result).toMatchObject({
			location: { kind: "scenario", name: "city-run" },
			ticker: { pid: 900, running: true },
		});
	});

	test.each([
		[["location", "set"]],
		[["location", "set", "95,0"]],
		[["location", "route"]],
		[["location", "route", "nope"]],
		[["location", "scenario", "moon"]],
		[["location", "gpx"]],
		[["location", "teleport"]],
		[["location", "route", "0,0", "--speed", "0"]],
	])("usage: %j", async (argv) => {
		const s = setup();
		expect(await s.h.run(...argv, "--json")).toBe(1);
		expect(doc(s.h.c).error.code).toBe("usage");
		expect(s.h.driver.callsOf("location")).toHaveLength(0);
	});
});

describe("ui status", () => {
	test("lists the conditions set on the lease", async () => {
		const s = setup();
		await s.h.run("net", "3g");
		await s.h.run("location", "set", "1,2");
		expect(await s.h.run("status", "--json")).toBe(0);
		expect(doc(s.h.c).result.conditions.map((c: { area: string }) => c.area)).toEqual(["network", "location"]);
		await s.h.run("status");
		expect(s.h.c.stdout.join("\n")).toContain("conditions network 3g · location 1,2");
	});
});
