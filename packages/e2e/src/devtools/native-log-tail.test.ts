import { describe, expect, test } from "bun:test";
import { androidTail, formatNativeTail, iosTail, TAIL_LINES, unresolvedShare } from "./native-log-tail";

const ev = (over: Record<string, unknown>): string =>
	JSON.stringify({
		eventType: "logEvent",
		messageType: "Default",
		subsystem: "com.example",
		category: "net",
		timestamp: "2026-11-05 18:45:56.413920+0000",
		eventMessage: "hello",
		...over,
	});

describe("iosTail", () => {
	test("one line per event: time, level, subsystem/category, message", () => {
		expect(iosTail(ev({ messageType: "Error", eventMessage: "SecError -25300" }))).toEqual([
			"18:45:56.413 error com.example/net SecError -25300",
		]);
	});

	test("drops activity events, compose failures and unparsable lines", () => {
		const text = [
			ev({ eventType: "activityCreateEvent" }),
			ev({ eventMessage: "<compose failure [shared UUID]>" }),
			"not json",
			ev({ eventMessage: "kept" }),
		].join("\n");
		expect(iosTail(text).map((l) => l.endsWith("kept"))).toEqual([true]);
	});

	test("caps at TAIL_LINES, errors and faults first, then the most recent rest, in time order", () => {
		const lines: string[] = [];
		for (let i = 0; i < 30; i++) {
			const s = String(i).padStart(2, "0");
			lines.push(ev({ eventMessage: `info ${i}`, timestamp: `2026-11-05 18:45:${s}.000000+0000` }));
		}
		lines.push(ev({ messageType: "Fault", eventMessage: "early fault", timestamp: "2026-11-05 18:44:00.000000+0000" }));
		const out = iosTail(lines.join("\n"));
		expect(out).toHaveLength(TAIL_LINES);
		expect(out[0]).toContain("early fault");
		expect(out[0]).toContain("fault");
		expect(out.at(-1)).toContain("info 29");
		expect(out.join("\n")).not.toContain("info 0 ");
	});

	test("long messages are cut", () => {
		const [line] = iosTail(ev({ eventMessage: "x".repeat(500) }));
		expect(line?.length).toBeLessThan(260);
		expect(line?.endsWith("…")).toBe(true);
	});

	test("empty or all-noise input gives no lines", () => {
		expect(iosTail("")).toEqual([]);
	});
});

describe("androidTail", () => {
	const lines = [
		"1730832356.123  100  100 I Tag: info line",
		"1730832357.456  100  100 E AndroidRuntime: FATAL EXCEPTION",
		"--- crash buffer ---",
		"1730832358.000  100  100 W Tag: warn line",
	].join("\n");

	test("errors and warnings before info, section markers dropped, time order kept", () => {
		const out = androidTail(lines);
		expect(out).toEqual([
			"1730832356.123  100  100 I Tag: info line",
			"1730832357.456  100  100 E AndroidRuntime: FATAL EXCEPTION",
			"1730832358.000  100  100 W Tag: warn line",
		]);
	});

	test("caps at TAIL_LINES keeping E/W", () => {
		const many = Array.from({ length: 40 }, (_, i) => `1730832356.${String(i).padStart(3, "0")}  1  1 I T: m${i}`);
		many.unshift("1730832300.000  1  1 E T: old error");
		const out = androidTail(many.join("\n"));
		expect(out).toHaveLength(TAIL_LINES);
		expect(out[0]).toContain("old error");
	});
});

describe("unresolvedShare", () => {
	test("share of log events whose message is a compose failure", () => {
		const text = [
			ev({ eventMessage: "<compose failure [shared UUID]>" }),
			ev({ eventMessage: "<compose failure [shared UUID]>" }),
			ev({ eventMessage: "<compose failure [shared UUID]>" }),
			ev({ eventMessage: "ok" }),
			ev({ eventType: "activityCreateEvent", eventMessage: "" }),
		].join("\n");
		expect(unresolvedShare(text)).toEqual({ unresolved: 3, total: 4 });
	});
});

describe("formatNativeTail", () => {
	test("header with the count, lines indented, nothing for none", () => {
		expect(formatNativeTail([])).toEqual([]);
		expect(formatNativeTail(["a", "b"])).toEqual([
			"  native log, last 2 lines before the failure (full: native.log):",
			"    a",
			"    b",
		]);
		expect(formatNativeTail(["a"])[0]).toContain("last 1 line before");
	});
});
