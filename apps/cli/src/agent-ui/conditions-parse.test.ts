import { describe, expect, test } from "bun:test";
import {
	parseFault,
	parseFlap,
	parseLatLon,
	parseLatLons,
	parseNetworkCondition,
	parsePositive,
	parseScenario,
} from "./conditions-parse";

describe("parseNetworkCondition", () => {
	test("words map to conditions", () => {
		expect(parseNetworkCondition("online", {})).toEqual({ success: true, data: { kind: "online" } });
		expect(parseNetworkCondition("offline", {})).toEqual({ success: true, data: { kind: "offline" } });
		expect(parseNetworkCondition("3g", {})).toEqual({ success: true, data: { kind: "preset", preset: "3g" } });
	});

	test("flags on a preset override its values as a custom condition", () => {
		const res = parseNetworkCondition("3g", { latency: "800", loss: "5" });
		expect(res).toMatchObject({
			success: true,
			data: { kind: "custom", latencyMs: 800, lossPct: 5, downKbps: 780, upKbps: 330, jitterMs: 10 },
		});
	});

	test("flags on online shape only what they name", () => {
		expect(parseNetworkCondition("online", { down: "500" })).toEqual({
			success: true,
			data: { kind: "custom", downKbps: 500 },
		});
	});

	test.each([
		["unknown word", "dialup", {}],
		["offline with flags", "offline", { latency: "10" }],
		["negative", "3g", { latency: "-1" }],
		["not a number", "3g", { down: "fast" }],
		["loss over 100", "lossy", { loss: "101" }],
	])("%s is a usage error", (_name, word, flags) => {
		const res = parseNetworkCondition(word, flags);
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error.code).toBe("usage");
	});
});

describe("parseFlap", () => {
	test("durations and optional jitter / seed", () => {
		expect(parseFlap({ up: "10s", down: "3s", jitter: "20", seed: "7" })).toEqual({
			success: true,
			data: { upMs: 10_000, downMs: 3_000, jitterPct: 20, seed: 7 },
		});
		expect(parseFlap({ up: "1", down: "500ms" })).toEqual({ success: true, data: { upMs: 1000, downMs: 500 } });
	});

	test.each([
		["no up", { down: "3s" }],
		["no down", { up: "3s" }],
		["bad duration", { up: "soon", down: "3s" }],
		["zero", { up: "0s", down: "3s" }],
		["jitter over 100", { up: "1s", down: "1s", jitter: "150" }],
		["fractional seed", { up: "1s", down: "1s", seed: "1.5" }],
	])("%s is a usage error", (_name, flags) => {
		expect(parseFlap(flags).success).toBe(false);
	});
});

describe("parseFault", () => {
	test("the four rules", () => {
		expect(parseFault("api.*", "status:503")).toEqual({
			success: true,
			data: { match: "api.*", action: { kind: "status", code: 503 } },
		});
		expect(parseFault("*", "reset")).toEqual({ success: true, data: { match: "*", action: { kind: "reset" } } });
		expect(parseFault("*", "blackhole")).toEqual({
			success: true,
			data: { match: "*", action: { kind: "blackhole" } },
		});
		expect(parseFault("cdn.x", "delay:2s")).toEqual({
			success: true,
			data: { match: "cdn.x", action: { kind: "delay", ms: 2000 } },
		});
	});

	test.each(["status", "status:99", "status:abc", "delay", "delay:soon", "reset:1", "nope"])(
		"%s is rejected",
		(rule) => {
			expect(parseFault("h", rule).success).toBe(false);
		}
	);
});

describe("locations", () => {
	test("parses a lat,lon", () => {
		expect(parseLatLon("37.33,-122.03")).toEqual({ success: true, data: { lat: 37.33, lon: -122.03 } });
		expect(parseLatLons(["0,0", "1, 2"])).toEqual({
			success: true,
			data: [
				{ lat: 0, lon: 0 },
				{ lat: 1, lon: 2 },
			],
		});
	});

	test.each(["91,0", "0,181", "x,y", "1", "1,2,3"])("%s is rejected", (raw) => {
		expect(parseLatLon(raw).success).toBe(false);
	});

	test("scenario and positive numbers", () => {
		expect(parseScenario("freeway").success).toBe(true);
		expect(parseScenario("moon").success).toBe(false);
		expect(parsePositive("2.5", "--speed")).toEqual({ success: true, data: 2.5 });
		expect(parsePositive(undefined, "--speed")).toEqual({ success: true, data: undefined });
		expect(parsePositive("0", "--speed").success).toBe(false);
	});
});
