import { describe, expect, test } from "bun:test";
import { mapBounded } from "./bounded";

describe("mapBounded", () => {
	test("never more than `limit` at once, every item once, results in item order", async () => {
		let running = 0;
		let peak = 0;
		const seen: number[] = [];
		const out = await mapBounded([5, 1, 4, 2, 3, 0, 6, 7], 3, async (n) => {
			running++;
			peak = Math.max(peak, running);
			await Bun.sleep(n);
			seen.push(n);
			running--;
			return n * 10;
		});
		expect(out).toEqual([50, 10, 40, 20, 30, 0, 60, 70]);
		expect(peak).toBe(3);
		expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	});

	test("fewer items than the limit, no items, a limit below one", async () => {
		expect(await mapBounded([1, 2], 8, async (n) => n + 1)).toEqual([2, 3]);
		expect(await mapBounded([], 4, async () => 1)).toEqual([]);
		expect(await mapBounded([1, 2, 3], 0, async (n) => n)).toEqual([1, 2, 3]);
	});

	test("the index is passed along", async () => {
		expect(await mapBounded(["a", "b"], 2, async (item, i) => `${i}${item}`)).toEqual(["0a", "1b"]);
	});

	test("a rejection rejects the call and starts nothing more", async () => {
		const started: number[] = [];
		await expect(
			mapBounded([1, 2, 3, 4, 5, 6], 2, async (n) => {
				started.push(n);
				await Bun.sleep(2);
				if (n === 2) throw new Error("boom");
				return n;
			})
		).rejects.toThrow("boom");
		await Bun.sleep(20);
		expect(started.length).toBeLessThan(6);
	});
});
