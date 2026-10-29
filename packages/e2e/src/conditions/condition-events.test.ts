import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openResults, readResults } from "../runner/results";
import { activeConditionsAt, type ConditionEvent, openConditionSink, readConditionEvents } from "./condition-events";

const net = (at: number, kind: "online" | "offline"): ConditionEvent => ({
	type: "condition",
	area: "network",
	value: { kind },
	at,
});
const loc = (at: number, lat: number): ConditionEvent => ({
	type: "condition",
	area: "location",
	value: { kind: "point", lat, lon: 0 },
	at,
});

describe("condition events in results.jsonl", () => {
	test("share the file with test results; each reader skips the other's lines", () => {
		const path = join(mkdtempSync(join(tmpdir(), "wdn-cond-")), "nested", "results.jsonl");
		const sink = openConditionSink(path);
		const results = openResults(path);
		sink(net(10, "offline"));
		results.append({
			file: "/a.e2e.ts",
			title: ["t"],
			status: "failed",
			durationMs: 5,
			startedAt: 9,
			device: { udid: "u", platform: "android" },
		});
		sink(loc(12, 1));
		const text = readFileSync(path, "utf8");
		expect(readResults(text)).toHaveLength(1);
		expect(readConditionEvents(text)).toEqual([net(10, "offline"), loc(12, 1)]);
	});

	test("malformed and foreign lines are skipped", () => {
		const text = [
			'{"type":"condition","area":"clock","value":{},"at":1}',
			"{",
			"null",
			JSON.stringify(net(3, "online")),
		].join("\n");
		expect(readConditionEvents(text)).toEqual([net(3, "online")]);
	});

	test("activeConditionsAt: the latest event per area at or before the time", () => {
		const events = [net(1, "online"), net(5, "offline"), loc(4, 7), net(9, "online")];
		expect(activeConditionsAt(events, 0)).toEqual({});
		expect(activeConditionsAt(events, 5)).toEqual({
			network: { kind: "offline" },
			location: { kind: "point", lat: 7, lon: 0 },
		});
		expect(activeConditionsAt(events, 100).network).toEqual({ kind: "online" });
	});
});
