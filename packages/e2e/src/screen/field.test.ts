import { describe, expect, test } from "bun:test";
import { failWith, fakeDriver, snapshotOf } from "../driver/driver.testing";
import {
	CONFIRM_READS,
	confirmFieldValue,
	FIELD_POLL_MS,
	type FieldReading,
	focusAndClear,
	focusClearType,
	STALE_RISK_READS,
} from "./field";
import { indexSnapshot } from "./nodes";
import { fakeClock } from "./poll.testing";
import { fieldFixture } from "./screen.testing";

/** Reads that play back `readings` one per look (the last one repeats). */
function scripted(readings: FieldReading[]) {
	const clock = fakeClock();
	let looks = 0;
	return {
		clock,
		looks: () => looks,
		run: (options: { text: string; budgetMs?: number; reads?: number; maxMs?: number }) =>
			confirmFieldValue<string>({
				text: options.text,
				now: clock.now,
				sleep: clock.sleep,
				budgetMs: options.budgetMs ?? 1000,
				...(options.reads === undefined ? {} : { reads: options.reads }),
				...(options.maxMs === undefined ? {} : { maxMs: options.maxMs }),
				read: async () => {
					const reading = readings[Math.min(looks, readings.length - 1)];
					looks += 1;
					return reading === undefined ? { ok: false, error: "no reading" } : { ok: true, reading };
				},
			}),
	};
}

const value = (text: string): FieldReading => ({ kind: "value", value: text });

describe("confirmFieldValue", () => {
	test("a single matching read is not enough: the next read must agree", async () => {
		const { run, looks, clock } = scripted([value("hi")]);
		expect(await run({ text: "hi" })).toEqual({ status: "confirmed" });
		expect(looks()).toBe(CONFIRM_READS);
		expect(clock.sleeps).toEqual([FIELD_POLL_MS]);
	});

	test("a stale value that matches once and then moves on does not confirm", async () => {
		const { run } = scripted([value("hi"), value("h"), value("hi"), value("hi")]);
		expect(await run({ text: "hi" })).toEqual({ status: "confirmed" });
	});

	test("the value lags and then matches", async () => {
		const { run, looks } = scripted([value(""), value(""), value(""), value("hello")]);
		expect(await run({ text: "hello" })).toEqual({ status: "confirmed" });
		expect(looks()).toBe(5);
	});

	test("a value that never matches is a mismatch carrying what the field holds (the first read counts as a change)", async () => {
		const { run, clock } = scripted([value("hell")]);
		expect(await run({ text: "hello", budgetMs: 500 })).toEqual({ status: "mismatch", held: "hell" });
		expect(clock.elapsed()).toBe(1000);
	});

	test("a value that keeps changing extends the wait, up to maxMs", async () => {
		const growing = Array.from({ length: 26 }, (_, n) => value("x".repeat(n)));
		const free = scripted(growing);
		expect(await free.run({ text: "x".repeat(25), budgetMs: 300 })).toEqual({ status: "confirmed" });
		const capped = scripted(growing);
		expect(await capped.run({ text: "x".repeat(25), budgetMs: 300, maxMs: 800 })).toMatchObject({ status: "mismatch" });
		expect(capped.clock.elapsed()).toBe(800);
	});

	test("more reads can be demanded when the old value could be mistaken for the new one", async () => {
		const { run, looks } = scripted([value("hi")]);
		expect(await run({ text: "hi", reads: STALE_RISK_READS })).toEqual({ status: "confirmed" });
		expect(looks()).toBe(STALE_RISK_READS);
	});

	test("an unreadable field reports its note and resets the run", async () => {
		const { run } = scripted([value("hi"), { kind: "unreadable", note: "(2 matches)" }]);
		expect(await run({ text: "hi", budgetMs: 300 })).toEqual({ status: "mismatch", held: "(2 matches)" });
	});

	test("a failed read ends the wait at once", async () => {
		const { run } = scripted([]);
		expect(await run({ text: "hi" })).toEqual({ status: "failed", error: "no reading" });
	});
});

describe("focusClearType", () => {
	const field = () => fieldFixture({ value: "ab" }).driver;
	const entryOf = (driver: ReturnType<typeof field>) => {
		const found = indexSnapshot(driver.screen).entries.find((candidate) => candidate.element.identifier === "field");
		if (found === undefined) throw new Error("no field");
		return found;
	};

	test("taps the caret spot, backspaces what the field shows plus a spare, then types", async () => {
		const driver = field();
		const clock = fakeClock();
		const result = await focusClearType(driver, clock.sleep, { x: 5, y: 6 }, entryOf(driver), "xy");
		expect(result.success).toBe(true);
		expect(driver.calls.map((call) => call.method)).toEqual(["tap", "key", "key", "key", "typeText"]);
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 5, y: 6 });
	});

	test("a bare coordinate has nothing to clear, and empty text only clears", async () => {
		const driver = field();
		const clock = fakeClock();
		await focusClearType(driver, clock.sleep, { x: 1, y: 2 }, undefined, "z");
		expect(driver.calls.map((call) => call.method)).toEqual(["tap", "typeText"]);
		const other = field();
		await focusAndClear(other, clock.sleep, { x: 1, y: 2 }, entryOf(other));
		expect(other.callsOf("typeText")).toEqual([]);
		expect(other.callsOf("key")).toHaveLength(3);
	});

	test("a failed tap stops before any key", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (call) => (call.method === "tap" ? failWith("E_TIMEOUT") : undefined),
		});
		const clock = fakeClock();
		const result = await focusClearType(driver, clock.sleep, { x: 1, y: 2 }, undefined, "z");
		expect(result.success).toBe(false);
		expect(driver.calls.map((call) => call.method)).toEqual(["tap"]);
	});
});
