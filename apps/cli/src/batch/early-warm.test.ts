import { describe, expect, test } from "bun:test";
import { type EarlyWarmDeps, startEarlyWarm } from "./early-warm";
import type { WarmConnect, WarmHelper } from "./warm-drivers";

type Fake = {
	deps: EarlyWarmDeps;
	/** `connect` calls in start order */
	started: string[];
	closed: string[];
	files: Map<string, string>;
	/** resolve the connect of one udid */
	release: (udid: string, outcome?: "ok" | "fail") => void;
};

/** `connect` waits for `release(udid)`; every start and close is logged. `after` never fires. */
function fake(): Fake {
	type Gate = { promise: Promise<"ok" | "fail">; resolve: (outcome: "ok" | "fail") => void };
	const gates = new Map<string, Gate>();
	const gate = (udid: string) => {
		const existing = gates.get(udid);
		if (existing) return existing;
		const made = Promise.withResolvers<"ok" | "fail">();
		gates.set(udid, made);
		return made;
	};
	const f: Fake = {
		started: [],
		closed: [],
		files: new Map(),
		release: (udid, outcome = "ok") => gate(udid).resolve(outcome),
		deps: {
			connect: (async (udid) => {
				f.started.push(udid);
				if ((await gate(udid).promise) === "fail") return { success: false, error: "helper did not start" };
				const helper: WarmHelper = {
					socketPath: `/s/${udid}.sock`,
					snapshot: async () => ({ success: true, data: null }),
					close: async () => {
						f.closed.push(udid);
					},
				};
				return { success: true, data: helper };
			}) satisfies WarmConnect,
			legCounts: [],
			logDir: "/logs",
			now: () => 1_000_000,
			after: () => () => {},
			writeFile: async (path, data) => {
				f.files.set(path, data);
			},
		},
	};
	return f;
}

const held = (...udids: string[]) => ({
	claimed: udids.map((udid) => ({ device: { id: udid, name: `warden-${udid}` } })),
});

describe("startEarlyWarm", () => {
	test("a leg's devices are warmed the moment they are leased, before anything settles", async () => {
		const f = fake();
		f.deps.legCounts = [2];
		const warm = startEarlyWarm(f.deps);
		expect(f.started).toEqual([]);
		warm.leased(held("U1", "U2"), 0);
		await Bun.sleep(0);
		expect(f.started.sort()).toEqual(["U1", "U2"]);
		f.release("U1");
		f.release("U2");
		const done = await warm.settled();
		expect(done.devices.map((d) => [d.worker, d.udid, d.ok])).toEqual([
			[0, "U1", true],
			[1, "U2", true],
		]);
		expect(done.helpers.map((h) => h.socketPath).sort()).toEqual(["/s/U1.sock", "/s/U2.sock"]);
	});

	test("worker numbers follow the leg order, whichever leg is leased first", async () => {
		const f = fake();
		f.deps.legCounts = [2, 1, 1];
		const warm = startEarlyWarm(f.deps);
		warm.leased(held("C1"), 2);
		warm.leased(held("B1"), 1);
		warm.leased(held("A1", "A2"), 0);
		for (const udid of ["A1", "A2", "B1", "C1"]) f.release(udid);
		const done = await warm.settled();
		expect(done.devices.map((d) => [d.worker, d.udid]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
			[0, "A1"],
			[1, "A2"],
			[2, "B1"],
			[3, "C1"],
		]);
		expect([...f.files.keys()].sort()).toEqual([
			"/logs/warm-0.log",
			"/logs/warm-1.log",
			"/logs/warm-2.log",
			"/logs/warm-3.log",
		]);
	});

	test("a failed warm-up is a warning in the outcome, not a printed line", async () => {
		const f = fake();
		f.deps.legCounts = [1];
		const warm = startEarlyWarm(f.deps);
		warm.leased(held("U1"), 0);
		f.release("U1", "fail");
		const done = await warm.settled();
		expect(done.devices[0]?.ok).toBe(false);
		expect(done.warnings).toEqual(["warm U1: helper did not start (continuing cold) — log: /logs/warm-0.log"]);
		expect(done.helpers).toEqual([]);
	});

	test("abort: settled returns at once, and a helper that comes up late is closed", async () => {
		const f = fake();
		f.deps.legCounts = [1];
		const warm = startEarlyWarm(f.deps);
		warm.leased(held("U1"), 0);
		await Bun.sleep(0);
		warm.abort();
		const done = await warm.settled();
		expect(done.devices[0]?.error).toBe("interrupted");
		f.release("U1");
		await Bun.sleep(5);
		expect(f.closed).toEqual(["U1"]);
	});

	test("the caller's signal aborts it too (SIGINT)", async () => {
		const f = fake();
		f.deps.legCounts = [1];
		const outer = new AbortController();
		const warm = startEarlyWarm({ ...f.deps, signal: outer.signal });
		warm.leased(held("U1"), 0);
		await Bun.sleep(0);
		outer.abort();
		expect((await warm.settled()).devices[0]?.error).toBe("interrupted");
	});

	test("device(udid): one device's warm-up, as soon as it is done, whatever the others do (12-3)", async () => {
		const f = fake();
		f.deps.legCounts = [2];
		const warm = startEarlyWarm(f.deps);
		warm.leased(held("U1", "U2"), 0);
		expect(warm.peek("U1")).toBeUndefined();
		f.release("U1");
		const u1 = await warm.device("U1");
		expect(u1.socketPath).toBe("/s/U1.sock");
		expect(u1.helper?.socketPath).toBe("/s/U1.sock");
		expect(u1.warning).toBeUndefined();
		expect(warm.peek("U1")).toEqual(u1);
		// U2 is still connecting: nothing waited for it
		expect(warm.peek("U2")).toBeUndefined();
		f.release("U2", "fail");
		const u2 = await warm.device("U2");
		expect(u2.socketPath).toBeUndefined();
		expect(u2.warning).toBe("warm U2: helper did not start (continuing cold) — log: /logs/warm-1.log");
	});

	test("device(udid) of a device never leased is cold at once", async () => {
		const warm = startEarlyWarm(fake().deps);
		expect(await warm.device("X")).toEqual({});
	});

	test("nothing leased: settled is an empty outcome", async () => {
		const f = fake();
		const warm = startEarlyWarm(f.deps);
		expect(await warm.settled()).toEqual({ devices: [], helpers: [], warnings: [] });
	});
});
