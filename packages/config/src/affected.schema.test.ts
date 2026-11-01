import { describe, expect, test } from "bun:test";
import { e2eSuiteSchema, suiteIsolation } from "./affected.schema";

const parse = (extra: Record<string, unknown> = {}) => e2eSuiteSchema.safeParse({ specsDir: "specs", ...extra });

function suite(extra: Record<string, unknown> = {}) {
	const res = parse(extra);
	if (!res.success) throw new Error(res.error.issues.map((i) => i.message).join("; "));
	return res.data;
}

const issues = (extra: Record<string, unknown>): string[] => {
	const res = parse(extra);
	return res.success ? [] : res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("suiteIsolation", () => {
	test("a suite that says nothing runs one spec process per device", () => {
		expect(suiteIsolation(suite())).toBe("device");
	});

	test("isolate: spec keeps one process per spec; isolate: device is the default spelled out", () => {
		expect(suiteIsolation(suite({ isolate: "spec" }))).toBe("spec");
		expect(suiteIsolation(suite({ isolate: "device" }))).toBe("device");
	});

	test("passes > 1 can't re-run a spec inside a shared process: the default falls back to spec", () => {
		expect(suiteIsolation(suite({ passes: 3 }))).toBe("spec");
	});

	test("asking for a process per device with passes > 1 is refused", () => {
		const message = 'passes: passes > 1 needs isolate "spec" (one process cannot be re-run per spec)';
		expect(issues({ isolate: "device", passes: 2 })).toEqual([message]);
		expect(issues({ isolate: "spec", passes: 2 })).toEqual([]);
	});

	test("unknown values are refused", () => {
		expect(issues({ isolate: "suite" })).not.toEqual([]);
	});
});

describe("e2e.<suite>.shutdown", () => {
	test("always | idle, unset by default (the run decides: idle locally, always in CI)", () => {
		expect(suite().shutdown).toBeUndefined();
		expect(suite({ shutdown: "always" }).shutdown).toBe("always");
		expect(suite({ shutdown: "idle" }).shutdown).toBe("idle");
		expect(issues({ shutdown: "never" })).not.toEqual([]);
	});
});

describe("perf budgets", () => {
	test("nonnegative numbers under known keys", () => {
		expect(suite({ perf: { budgets: { jankPct: 5, peakMemoryMb: 300 } } }).perf?.budgets).toEqual({
			jankPct: 5,
			peakMemoryMb: 300,
		});
		expect(issues({ perf: { budgets: { jankPct: -1 } } })).not.toEqual([]);
		expect(issues({ perf: { budgets: { bogus: 1 } } })).not.toEqual([]);
		expect(issues({ perf: { extra: 1 } })).not.toEqual([]);
	});
});

describe("physical", () => {
	test("true or { ids } on a suite and on a leg; unset by default", () => {
		expect(suite().physical).toBeUndefined();
		expect(suite({ physical: true }).physical).toBe(true);
		expect(suite({ physical: { ids: ["R5CT"] } }).physical).toEqual({ ids: ["R5CT"] });
		const legs = suite({ devices: [{ profile: "pixel-8", physical: { ids: ["R5CT"] } }, { profile: "auto" }] }).devices;
		expect(legs?.[0]?.physical).toEqual({ ids: ["R5CT"] });
		expect(legs?.[1]?.physical).toBeUndefined();
	});

	test("false, empty ids and unknown keys are refused", () => {
		expect(issues({ physical: false })).not.toEqual([]);
		expect(issues({ physical: { ids: [] } })).not.toEqual([]);
		expect(issues({ physical: { ids: ["a"], extra: 1 } })).not.toEqual([]);
	});

	test("slim and headless contradict physical", () => {
		expect(issues({ physical: true, slim: true })).toEqual(["slim: slim cannot be used with physical devices"]);
		expect(issues({ physical: true, headless: true })).toEqual([
			"headless: headless cannot be used with physical devices",
		]);
		expect(issues({ physical: true, slim: false, headless: false })).toEqual([]);
	});

	test("biometrics contradict physical: a real sensor cannot be enrolled or matched", () => {
		expect(issues({ physical: true, biometrics: true })).toEqual([
			"biometrics: biometrics cannot be used with physical devices (use a simulator or emulator suite)",
		]);
		expect(issues({ physical: true, biometrics: false })).toEqual([]);
	});

	test("conditions contradict physical: a phone's network, clock and settings are not warden's to change", () => {
		expect(issues({ physical: true, conditions: { network: "3g" } })).toEqual([
			"conditions: conditions cannot be used with physical devices (use a simulator or emulator suite)",
		]);
	});
});

describe("e2e.<suite>.conditions", () => {
	test("network, location and clock, strict keys", () => {
		expect(
			suite({ conditions: { network: "3g", location: { lat: 1, lon: 2 }, clock: "2026-01-01T00:00:00Z" } }).conditions
		).toEqual({ network: "3g", location: { lat: 1, lon: 2 }, clock: "2026-01-01T00:00:00Z" });
		expect(issues({ conditions: { network: "5g" } })).not.toEqual([]);
		expect(issues({ conditions: { battery: 1 } })).not.toEqual([]);
	});
});
