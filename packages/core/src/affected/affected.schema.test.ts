import { describe, expect, test } from "bun:test";
import { e2eSuiteSchema, suiteIsolation } from "./affected.schema";

const parse = (extra: Record<string, unknown> = {}) => e2eSuiteSchema.safeParse({ flowsDir: "flows", ...extra });

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

	test("isolate: flow keeps one process per flow; isolate: device is the default spelled out", () => {
		expect(suiteIsolation(suite({ isolate: "flow" }))).toBe("flow");
		expect(suiteIsolation(suite({ isolate: "device" }))).toBe("device");
	});

	test("mode is the old spelling: per-flow = flow, single = device", () => {
		expect(suiteIsolation(suite({ mode: "per-flow" }))).toBe("flow");
		expect(suiteIsolation(suite({ mode: "single" }))).toBe("device");
	});

	test("passes > 1 can't re-run a flow inside a shared process: the default falls back to flow", () => {
		expect(suiteIsolation(suite({ passes: 3 }))).toBe("flow");
	});

	test("isolate and mode that agree are fine, ones that disagree are named", () => {
		expect(suiteIsolation(suite({ isolate: "flow", mode: "per-flow" }))).toBe("flow");
		expect(issues({ isolate: "flow", mode: "single" })).toEqual([
			'mode: mode "single" means isolate "device", not "flow" (drop mode)',
		]);
		expect(issues({ isolate: "device", mode: "per-flow" })).toEqual([
			'mode: mode "per-flow" means isolate "flow", not "device" (drop mode)',
		]);
	});

	test("asking for a process per device with passes > 1 is refused, either spelling", () => {
		const message = 'passes: passes > 1 needs isolate "flow" (one process cannot be re-run per flow)';
		expect(issues({ isolate: "device", passes: 2 })).toEqual([message]);
		expect(issues({ mode: "single", passes: 2 })).toEqual([message]);
		expect(issues({ isolate: "flow", passes: 2 })).toEqual([]);
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
