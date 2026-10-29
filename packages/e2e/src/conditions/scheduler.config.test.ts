import { describe, expect, test } from "bun:test";
import { parseSchedulerConfig } from "./scheduler.config";

const parse = (v: unknown) => parseSchedulerConfig(JSON.stringify(v));
const android = { platform: "android", id: "emulator-5554", adb: "adb" };

describe("parseSchedulerConfig", () => {
	test("accepts a flap and a timeline", () => {
		expect(parse({ ...android, mode: "flap", flap: { upMs: 1, downMs: 2, jitterPct: 10 } }).success).toBe(true);
		expect(
			parse({
				...android,
				mode: "timeline",
				steps: [
					{ atMs: 0, network: { kind: "offline" } },
					{ atMs: 5, location: { kind: "clear" } },
				],
			}).success
		).toBe(true);
	});

	test("an ios config needs the lease whose proxy it drives", () => {
		const ios = { platform: "ios", id: "U-1", mode: "flap", flap: { upMs: 1, downMs: 2 } };
		expect(parse(ios).success).toBe(false);
		const lease = { id: "L1", owner: { kind: "ci", runId: "r" }, ttlMs: 1000 };
		expect(parse({ ...ios, lease }).success).toBe(true);
	});

	test.each([
		["not json", "{"],
		["not an object", "3"],
		["no platform", { id: "x", mode: "flap", flap: { upMs: 1, downMs: 1 } }],
		["android without adb", { platform: "android", id: "x", mode: "flap", flap: { upMs: 1, downMs: 1 } }],
		["no id", { platform: "ios", mode: "flap", flap: { upMs: 1, downMs: 1 } }],
		["flap without durations", { ...android, mode: "flap", flap: { upMs: 1 } }],
		["empty timeline", { ...android, mode: "timeline", steps: [] }],
		["step with nothing to apply", { ...android, mode: "timeline", steps: [{ atMs: 0 }] }],
		["unknown mode", { ...android, mode: "x" }],
	])("rejects %s", (_name, value) => {
		expect(parseSchedulerConfig(typeof value === "string" ? value : JSON.stringify(value)).success).toBe(false);
	});
});
