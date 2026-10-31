import { describe, expect, test } from "bun:test";
import type { LogLine } from "@/modules/showcase/components/event-log";
import { eventsFor, JUMP_THRESHOLD_MS, jumpOf, MAX_EVENTS, pushEvents, type Sample } from "./clock-events";

const DAY = 86_400_000;
const START = Date.parse("2026-10-30T09:41:00Z");
const at = (wall: number, mono: number): Sample => ({ wall, mono });

describe("jumpOf", () => {
	test("none when wall time moved as much as the monotonic clock", () => {
		expect(jumpOf(at(START, 1000), at(START + 1000, 2000))).toBeNull();
		expect(jumpOf(at(START, 1000), at(START + 1000 + JUMP_THRESHOLD_MS - 1, 2000))).toBeNull();
	});

	test("forward jump is the extra wall time", () => {
		expect(jumpOf(at(START, 1000), at(START + 10 * DAY + 1000, 2000))).toBe(10 * DAY);
	});

	test("backward jump is negative", () => {
		expect(jumpOf(at(START + 15 * DAY, 1000), at(START + 1000, 2000))).toBe(-15 * DAY);
	});
});

describe("eventsFor", () => {
	test("nothing on an ordinary tick", () => {
		expect(eventsFor(at(START, 0), at(START + 1000, 1000), START, 1000)).toEqual([]);
	});

	test("a jump that stays inside the trial", () => {
		expect(eventsFor(at(START, 0), at(START + 10 * DAY + 1000, 1000), START, 1000)).toEqual([
			{ at: 1000, text: "clock jumped +10d 0h", tone: "scan" },
		]);
	});

	test("a jump past day 14 logs the jump, then the expiry", () => {
		const lines = eventsFor(at(START + 10 * DAY, 0), at(START + 15 * DAY + 1000, 1000), START, 2000);
		expect(lines.map((l) => l.text)).toEqual(["clock jumped +5d 0h", "trial expired"]);
		expect(lines[1]?.tone).toBe("warn");
	});

	test("going back logs the jump and that the trial is active again", () => {
		const lines = eventsFor(at(START + 15 * DAY, 0), at(START + 1000, 1000), START, 3000);
		expect(lines.map((l) => l.text)).toEqual(["clock jumped −15d 0h", "trial active again"]);
		expect(lines[1]?.tone).toBe("open");
	});

	test("expiry by real time alone is still logged", () => {
		const lines = eventsFor(at(START + 14 * DAY, 0), at(START + 14 * DAY + 1000, 1000), START, 1000);
		expect(lines.map((l) => l.text)).toEqual(["trial expired"]);
	});
});

describe("pushEvents", () => {
	test("newest first, capped", () => {
		const line = (n: number): LogLine => ({ at: n, text: `e${n}`, tone: "idle" });
		let log: LogLine[] = [line(0)];
		for (let n = 1; n <= MAX_EVENTS + 2; n++) log = pushEvents(log, [line(n)]);
		expect(log).toHaveLength(MAX_EVENTS);
		expect(log[0]?.text).toBe(`e${MAX_EVENTS + 2}`);
	});

	test("lines pushed together keep their order, last on top", () => {
		const a = { at: 1, text: "a", tone: "scan" as const };
		const b = { at: 1, text: "b", tone: "warn" as const };
		expect(pushEvents([], [a, b]).map((l) => l.text)).toEqual(["b", "a"]);
	});
});
