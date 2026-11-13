import { describe, expect, test } from "bun:test";
import { readDeadlineRemaining } from "../driver/read-deadline";
import { Runtime } from "./context";
import { staticDriver, testHost } from "./screen.testing";

describe("Runtime.poll read deadline", () => {
	test("every attempt runs inside the poll's deadline, so a driver read inside it sees what is left", async () => {
		const host = testHost(staticDriver([]));
		const rt = new Runtime(host);
		const seen: Array<number | undefined> = [];
		const result = await rt.poll<true, undefined>(
			(attempt) => {
				seen.push(readDeadlineRemaining());
				return attempt < 3 ? { done: false, state: undefined } : { done: true, value: true };
			},
			5_000,
			{ intervalMs: 1_000 }
		);
		expect(result.status).toBe("done");
		expect(seen).toEqual([5_000, 4_000, 3_000]);
		expect(readDeadlineRemaining()).toBeUndefined();
	});

	test("a poll inside another keeps the nearer deadline", async () => {
		const host = testHost(staticDriver([]));
		const rt = new Runtime(host);
		const seen: Array<number | undefined> = [];
		await rt.poll<true, undefined>(async () => {
			await rt.poll<true, undefined>(() => {
				seen.push(readDeadlineRemaining());
				return { done: true, value: true };
			}, 60_000);
			seen.push(readDeadlineRemaining());
			return { done: true, value: true };
		}, 2_000);
		expect(seen).toEqual([2_000, 2_000]);
	});
});
