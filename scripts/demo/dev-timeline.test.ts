import { describe, expect, test } from "bun:test";
import type { DevBeat, RecordedBeat } from "./demo.types";
import {
	buildSegments,
	captionSpans,
	castText,
	cutAtAltScreenExit,
	deviceLeaseOf,
	leasesHeldBy,
	outputDuration,
	outputTime,
	planRamps,
	rampSpans,
	screenMatches,
} from "./dev-timeline";

const beat = (id: string, o: Partial<DevBeat> = {}): DevBeat => ({
	id,
	caption: id,
	timeoutMs: 1000,
	pauseAfterMs: 0,
	...o,
});
const rec = (id: string, startS: number, readyS: number, endS: number): RecordedBeat => ({ id, startS, readyS, endS });

describe("castText", () => {
	test("header then one event per chunk, never going back in time", () => {
		const lines = castText(
			[
				{ atS: 0.5, data: "a" },
				{ atS: 0.2, data: "b" },
				{ atS: -1, data: "c" },
			],
			100,
			34
		)
			.trim()
			.split("\n");
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({ version: 2, width: 100, height: 34 });
		expect(lines.slice(1).map((l) => JSON.parse(l))).toEqual([
			[0.5, "o", "a"],
			[0.5, "o", "b"],
			[0.5, "o", "c"],
		]);
	});
});

describe("segments", () => {
	test("gaps run at speed 1 and the whole range is covered", () => {
		const segs = buildSegments(30, [{ fromS: 5, toS: 25, speed: 4 }]);
		expect(segs).toEqual([
			{ fromS: 0, toS: 5, speed: 1 },
			{ fromS: 5, toS: 25, speed: 4 },
			{ fromS: 25, toS: 30, speed: 1 },
		]);
		expect(outputDuration(segs)).toBe(15);
	});
	test("output time is piecewise linear", () => {
		const segs = buildSegments(30, [{ fromS: 5, toS: 25, speed: 4 }]);
		expect(outputTime(segs, 3)).toBe(3);
		expect(outputTime(segs, 13)).toBe(7);
		expect(outputTime(segs, 25)).toBe(10);
		expect(outputTime(segs, 100)).toBe(15);
	});
	test("overlapping ramps are rejected", () => {
		expect(() =>
			buildSegments(30, [
				{ fromS: 5, toS: 20, speed: 2 },
				{ fromS: 10, toS: 25, speed: 2 },
			])
		).toThrow("overlaps");
	});
	test("no ramps = one speed-1 segment", () => {
		expect(buildSegments(10, [])).toEqual([{ fromS: 0, toS: 10, speed: 1 }]);
	});
});

describe("planRamps", () => {
	test("keeps the head and tail of a long wait at real speed", () => {
		const ramps = planRamps([beat("build", { ramp: 6 })], [rec("build", 2, 40, 41)]);
		expect(ramps).toEqual([{ fromS: 3.2, toS: 39, speed: 6 }]);
	});
	test("a short wait or no ramp request is left alone", () => {
		expect(planRamps([beat("a", { ramp: 6 })], [rec("a", 0, 6, 7)])).toEqual([]);
		expect(planRamps([beat("a")], [rec("a", 0, 40, 41)])).toEqual([]);
	});
});

describe("captions and tags", () => {
	const defs = [beat("one"), beat("two"), beat("three")];
	const beats = [rec("one", 0, 1, 2), rec("two", 2, 12, 13), rec("three", 13, 14, 15)];
	const segs = buildSegments(20, [{ fromS: 3, toS: 11, speed: 4 }]);
	test("each caption runs to the next beat's action, on the output clock", () => {
		expect(captionSpans(defs, beats, segs)).toEqual([
			{ text: "one", fromS: 1, toS: 6 },
			{ text: "two", fromS: 6, toS: 8 },
			{ text: "three", fromS: 8, toS: null },
		]);
	});
	test("ramp spans are on the output clock", () => {
		expect(rampSpans(segs)).toEqual([{ fromS: 3, toS: 5, speed: 4 }]);
	});
});

describe("screenMatches", () => {
	test("regex over the joined frame; absent matches", () => {
		expect(screenMatches(undefined, [])).toBe(true);
		expect(screenMatches("✓ dev client", ["a", "  ✓ dev client  1s"])).toBe(true);
		expect(screenMatches("✓ dev client", ["· dev client"])).toBe(false);
	});
});

describe("cutAtAltScreenExit", () => {
	test("keeps what precedes the alt screen exit and reports when it happened", () => {
		const { kept, exitS } = cutAtAltScreenExit([
			{ atS: 1, data: "a" },
			{ atS: 2, data: "bye\u001b[?1049lblank" },
			{ atS: 3, data: "after" },
		]);
		expect(kept).toEqual([
			{ atS: 1, data: "a" },
			{ atS: 2, data: "bye" },
		]);
		expect(exitS).toBe(2);
	});
	test("no exit = everything, null", () => {
		expect(cutAtAltScreenExit([{ atS: 1, data: "a" }])).toEqual({ kept: [{ atS: 1, data: "a" }], exitS: null });
	});
});

describe("ls --json readers", () => {
	const ls = JSON.stringify({
		leases: [
			{ id: "l_1", label: "demo", resource: { kind: "device", id: "UDID" }, pid: 5 },
			{ id: "l_2", label: "warden dev", resource: { kind: "port", port: 8082 }, pid: 77 },
			{ id: "l_3", label: "other", resource: { kind: "port", port: 8083 }, pid: 9 },
		],
	});
	test("finds the labelled device lease", () => {
		expect(deviceLeaseOf(ls, "demo")).toEqual({ leaseId: "l_1", udid: "UDID" });
		expect(deviceLeaseOf(ls, "nope")).toBeUndefined();
	});
	test("a queued claim (`pending:` id) is not a device yet", () => {
		const queued = JSON.stringify({
			leases: [{ id: "l_9", label: "demo", resource: { kind: "device", id: "pending:warden-1" } }],
		});
		expect(deviceLeaseOf(queued, "demo")).toBeUndefined();
	});
	test("a session's leases are its label and its pid", () => {
		expect(leasesHeldBy(ls, "demo", 77)).toEqual(["l_1", "l_2"]);
		expect(leasesHeldBy(ls, "gone", 1)).toEqual([]);
	});
});
