import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAdTiming } from "./ad-timing";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "../fixtures/agent-device", name), "utf8");

describe("parseAdTiming", () => {
	test("one step per finished action, labelled with the script line", () => {
		const steps = parseAdTiming(fixture("replay-timing-onboarding.ndjson"), fixture("replay-onboarding.ad"));
		expect(steps).toHaveLength(8);
		expect(steps[0]).toEqual({
			kind: "open",
			label: "open nz.co.delacour.warden.example --relaunch",
			ms: 1299,
			status: "passed",
		});
		expect(steps[1]?.kind).toBe("wait");
		expect(steps[1]?.label).toBe('wait "id=\\"welcome-screen\\"" 30000');
		expect(steps.every((s) => s.status === "passed")).toBe(true);
		expect(steps.map((s) => s.ms)).toEqual([1299, 1094, 817, 163, 536, 152, 510, 165]);
	});

	test("a failed action is a failed step and nothing after it appears", () => {
		const steps = parseAdTiming(fixture("replay-timing-failed.ndjson"), fixture("replay-onboarding.ad"));
		expect(steps.map((s) => [s.kind, s.status])).toEqual([
			["open", "passed"],
			["wait", "failed"],
		]);
	});

	test("falls back to the command when the script line is unknown, and skips junk lines", () => {
		const ndjson = [
			"not json",
			'{"type":"replay_action_stop","line":9,"command":"press","ok":true,"durationMs":5}',
			'{"type":"replay_action_start","line":1,"command":"open"}',
			'{"type":"replay_action_stop","line":"x","command":"press","ok":true,"durationMs":5}',
		].join("\n");
		expect(parseAdTiming(ndjson, "open a")).toEqual([{ kind: "press", label: "press", ms: 5, status: "passed" }]);
	});
});
