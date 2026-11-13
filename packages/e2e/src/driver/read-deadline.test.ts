import { describe, expect, test } from "bun:test";
import { readDeadlineRemaining, withReadDeadline } from "./read-deadline";

describe("read deadline", () => {
	test("outside a deadline there is none", () => {
		expect(readDeadlineRemaining()).toBeUndefined();
	});

	test("inside one, reads see what is left of it, across awaits", async () => {
		let t = 0;
		const seen = await withReadDeadline(
			() => 5_000 - t,
			async () => {
				const first = readDeadlineRemaining();
				await Promise.resolve();
				t = 1_500;
				return [first, readDeadlineRemaining()];
			}
		);
		expect(seen).toEqual([5_000, 3_500]);
	});

	test("a deadline that has passed reads as 0, never negative", () => {
		expect(
			withReadDeadline(
				() => -200,
				() => readDeadlineRemaining()
			)
		).toBe(0);
	});

	test("the innermost deadline wins and the outer one is back after it", () => {
		withReadDeadline(
			() => 9_000,
			() => {
				expect(
					withReadDeadline(
						() => 1_000,
						() => readDeadlineRemaining()
					)
				).toBe(1_000);
				expect(readDeadlineRemaining()).toBe(9_000);
			}
		);
	});
});
