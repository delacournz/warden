import { describe, expect, test } from "bun:test";
import { type PoolTask, runPool } from "./signoff-pool";

/** A task that records when it starts and finishes, and resolves when the test releases it. */
function tracked(
	name: string,
	locks: readonly string[],
	log: string[],
	gates: Map<string, () => void>
): PoolTask<string> {
	return {
		locks,
		run: () =>
			new Promise<string>((resolve) => {
				log.push(`start ${name}`);
				gates.set(name, () => {
					log.push(`end ${name}`);
					resolve(name);
				});
			}),
	};
}

/** Let every pending microtask (and the pool's scheduling that follows a resolve) settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function inFlight(log: readonly string[]): number {
	let running = 0;
	let peak = 0;
	for (const entry of log) {
		running += entry.startsWith("start") ? 1 : -1;
		peak = Math.max(peak, running);
	}
	return peak;
}

describe("runPool", () => {
	test("never runs more than `limit` tasks at once, and uses every slot", async () => {
		const log: string[] = [];
		const tasks = ["a", "b", "c", "d", "e"].map((name) => ({
			locks: [],
			run: async () => {
				log.push(`start ${name}`);
				await flush();
				log.push(`end ${name}`);
				return name;
			},
		}));
		await runPool(tasks, 3);
		expect(inFlight(log)).toBe(3);
	});

	test("returns results in declaration order, not completion order", async () => {
		const log: string[] = [];
		const gates = new Map<string, () => void>();
		const done = runPool([tracked("a", [], log, gates), tracked("b", [], log, gates)], 2);
		await flush();
		gates.get("b")?.();
		await flush();
		gates.get("a")?.();
		expect(await done).toEqual(["a", "b"]);
	});

	test("tasks that share a lock never overlap", async () => {
		const log: string[] = [];
		const gates = new Map<string, () => void>();
		const done = runPool([tracked("a", ["port:3030"], log, gates), tracked("b", ["port:3030"], log, gates)], 3);
		await flush();
		expect(log).toEqual(["start a"]);
		gates.get("a")?.();
		await flush();
		expect(log).toEqual(["start a", "end a", "start b"]);
		gates.get("b")?.();
		await done;
	});

	test("a lock-blocked task does not hold back a later free one", async () => {
		const log: string[] = [];
		const gates = new Map<string, () => void>();
		const done = runPool(
			[tracked("a", ["cargo"], log, gates), tracked("b", ["cargo"], log, gates), tracked("c", [], log, gates)],
			3
		);
		await flush();
		expect(log).toEqual(["start a", "start c"]);
		for (const name of ["a", "c"]) gates.get(name)?.();
		await flush();
		gates.get("b")?.();
		expect(await done).toEqual(["a", "b", "c"]);
	});

	test("limit 1 is strictly serial, in declaration order", async () => {
		const log: string[] = [];
		const tasks = ["a", "b", "c"].map((name) => ({
			locks: [],
			run: async () => {
				log.push(`start ${name}`);
				await flush();
				log.push(`end ${name}`);
				return name;
			},
		}));
		await runPool(tasks, 1);
		expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
	});

	test("an empty list resolves to an empty list", async () => {
		expect(await runPool([], 3)).toEqual([]);
	});

	test("a limit below 1 is rejected rather than hanging forever", async () => {
		expect(runPool([{ locks: [], run: async () => 1 }], 0)).rejects.toThrow();
	});
});
