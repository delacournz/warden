import { describe, expect, test } from "bun:test";
import { type BatchHandle, type BatchWorker, runBatch } from "@delacour/warden-core/batch/schedule";
import type { CapacityDeps } from "@delacour/warden-core/claim";
import type { InventoryDevice } from "@delacour/warden-core/types";
import { err, ok } from "@delacour/warden-types/result";
import { claimLateWorkers, type LateWorker, planElastic } from "./elastic";

const capacity = (cpu: number, booted: number): CapacityDeps => ({
	budget: { memMb: 1_000_000, cpu, maxUnits: Number.POSITIVE_INFINITY },
	config: {},
	hostInventory: async () =>
		ok(
			Array.from(
				{ length: booted },
				(_, i) => ({ id: `b${i}`, name: `b${i}`, platform: "ios", state: "booted", profile: "p" }) as InventoryDevice
			)
		),
});

describe("planElastic", () => {
	test("4 wanted, 2 fit: 2 now, 2 later", async () => {
		expect(await planElastic(capacity(2, 0), "ios", 4)).toEqual({ first: 2, extra: 2 });
	});
	test("a full host still claims one worker first", async () => {
		expect(await planElastic(capacity(2, 2), "ios", 3)).toEqual({ first: 1, extra: 2 });
	});
	test("everything fits, one worker or capacity off: no plan", async () => {
		expect(await planElastic(capacity(8, 0), "ios", 4)).toBeUndefined();
		expect(await planElastic(capacity(2, 0), "ios", 1)).toBeUndefined();
		expect(await planElastic(undefined, "ios", 4)).toBeUndefined();
	});
});

const flush = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** A run of `jobs` on W0, jobs finish when the test settles them. */
function harness(jobs: string[], signal?: AbortSignal) {
	const pending = new Map<string, { worker: number; settle: (code: number) => void }>();
	let handle: BatchHandle | undefined;
	const done = runBatch({
		workers: [{ worker: 0, udid: "U0" }],
		jobs,
		retry: 0,
		now: () => 0,
		...(signal ? { signal } : {}),
		onStart: (h) => {
			handle = h;
		},
		run: (w, job) =>
			new Promise<number>((resolve) => {
				pending.set(job, { worker: w.worker, settle: resolve });
			}),
	});
	return { pending, done, handle: () => handle as BatchHandle };
}

describe("claimLateWorkers", () => {
	test("a freed slot lets the next worker join and take queued jobs", async () => {
		const h = harness(["a", "b", "c"]);
		await flush();
		const logs: string[] = [];
		const dropped: number[] = [];
		const late = claimLateWorkers({
			count: 1,
			firstWorker: 1,
			handle: h.handle(),
			signal: new AbortController().signal,
			log: (l) => logs.push(l),
			claim: async ({ worker }): Promise<ReturnType<typeof ok<LateWorker>>> =>
				ok({ worker: { worker, udid: `U${worker}` }, drop: async () => void dropped.push(worker) }),
		});
		expect(await late).toEqual({ joined: 1, dropped: 0 });
		await flush();
		expect([...h.pending.entries()].map(([job, p]) => [job, p.worker])).toEqual([
			["a", 0],
			["b", 1],
		]);
		for (const job of ["a", "b"]) h.pending.get(job)?.settle(0);
		await flush();
		h.pending.get("c")?.settle(0);
		expect((await h.done).ok).toBe(true);
		expect(dropped).toEqual([]);
	});

	test("a claim landing after the queue drained is released", async () => {
		const h = harness(["a", "b"]);
		await flush();
		const dropped: number[] = [];
		const logs: string[] = [];
		let land: (w: LateWorker) => void = () => {};
		const late = claimLateWorkers({
			count: 2,
			firstWorker: 1,
			handle: h.handle(),
			signal: new AbortController().signal,
			log: (l) => logs.push(l),
			claim: ({ worker }) =>
				new Promise((resolve) => {
					land = (w) => resolve(ok(w));
					void worker;
				}),
		});
		await flush();
		h.pending.get("a")?.settle(0);
		await flush();
		land({ worker: { worker: 1, udid: "U1" }, drop: async () => void dropped.push(1) });
		expect(await late).toEqual({ joined: 0, dropped: 1 });
		expect(dropped).toEqual([1]);
		expect(logs.join("\n")).toContain("worker 2 released");
		h.pending.get("b")?.settle(0);
		expect((await h.done).ok).toBe(true);
	});

	test("abort flips once no job is left; a failed claim after that is silent", async () => {
		const h = harness(["a", "b"]);
		await flush();
		const logs: string[] = [];
		const seen: boolean[] = [];
		let fail: () => void = () => {};
		const late = claimLateWorkers({
			count: 3,
			firstWorker: 1,
			handle: h.handle(),
			signal: new AbortController().signal,
			log: (l) => logs.push(l),
			claim: ({ abort }) =>
				new Promise((resolve) => {
					seen.push(abort());
					fail = () => {
						seen.push(abort());
						resolve(err("timed out in the boot queue"));
					};
				}),
		});
		await flush();
		h.pending.get("a")?.settle(0);
		await flush();
		fail();
		expect(await late).toEqual({ joined: 0, dropped: 0 });
		expect(seen).toEqual([false, true]);
		expect(logs).toEqual([]);
		h.pending.get("b")?.settle(0);
		await h.done;
	});

	test("SIGINT aborts a pending claim and releases nothing it never got", async () => {
		const ac = new AbortController();
		const h = harness(["a", "b"], ac.signal);
		await flush();
		const logs: string[] = [];
		const late = claimLateWorkers({
			count: 2,
			firstWorker: 1,
			handle: h.handle(),
			signal: ac.signal,
			log: (l) => logs.push(l),
			claim: ({ abort }) =>
				new Promise((resolve) => {
					const timer = setInterval(() => {
						if (abort()) {
							clearInterval(timer);
							resolve(err("claim aborted"));
						}
					}, 1);
				}),
		});
		await flush();
		ac.abort();
		expect(await late).toEqual({ joined: 0, dropped: 0 });
		expect(logs).toEqual([]);
		h.pending.get("a")?.settle(130);
		expect((await h.done).stopped).toBe(true);
	});

	test("a worker claimed just as SIGINT lands is dropped, not joined", async () => {
		const ac = new AbortController();
		const h = harness(["a", "b"], ac.signal);
		await flush();
		const dropped: BatchWorker[] = [];
		const late = claimLateWorkers({
			count: 1,
			firstWorker: 1,
			handle: h.handle(),
			signal: ac.signal,
			log: () => {},
			claim: async ({ worker }) => {
				ac.abort();
				return ok({ worker: { worker, udid: "U1" }, drop: async () => void dropped.push({ worker, udid: "U1" }) });
			},
		});
		expect(await late).toEqual({ joined: 0, dropped: 1 });
		expect(dropped).toHaveLength(1);
		h.pending.get("a")?.settle(130);
		await h.done;
	});
});
