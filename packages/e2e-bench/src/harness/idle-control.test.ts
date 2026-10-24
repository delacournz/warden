import { describe, expect, test } from "bun:test";
import type { Series } from "../results/schema";
import { idleSummary, parseIdleArgs } from "./idle-control";

const series = (over: Partial<Series>): Series => ({
	cpuAvgPct: 0,
	cpuPeakPct: 0,
	rssAvgBytes: 0,
	rssPeakBytes: 0,
	samples: 0,
	...over,
});

describe("parseIdleArgs", () => {
	test("needs a udid and defaults the rest", () => {
		const r = parseIdleArgs(["--udid", "ABC"]);
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data).toEqual({ udid: "ABC", seconds: 60, pids: [], out: undefined, launch: undefined });
	});
	test("reads seconds, pids, out and launch", () => {
		const r = parseIdleArgs([
			"--udid",
			"ABC",
			"--seconds",
			"30",
			"--pids",
			"12,34",
			"--out",
			"x.ndjson",
			"--launch",
			"com.x",
		]);
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data).toEqual({ udid: "ABC", seconds: 30, pids: [12, 34], out: "x.ndjson", launch: "com.x" });
	});
	test("rejects a missing udid, a bad number and an unknown flag", () => {
		expect(parseIdleArgs([]).success).toBe(false);
		expect(parseIdleArgs(["--udid", "A", "--seconds", "x"]).success).toBe(false);
		expect(parseIdleArgs(["--udid", "A", "--bogus"]).success).toBe(false);
	});
});

describe("idleSummary", () => {
	test("prints sim and host lines with CPU-seconds when present", () => {
		const sim = series({
			cpuAvgPct: 12.34,
			cpuPeakPct: 50,
			rssAvgBytes: 2e9,
			rssPeakBytes: 2.5e9,
			samples: 120,
			cpuSeconds: 7.2,
		});
		const host = series({ samples: 120 });
		const text = idleSummary({ sim, host, seconds: 60 });
		expect(text).toContain("sim: 7.20 CPU-s over 60 s (12.0% of one core)");
		expect(text).toContain("%cpu avg 12.3 / peak 50.0");
		expect(text).toContain("RSS avg 1.9 GB / peak 2.3 GB");
		expect(text).toContain("host: no CPU-seconds");
	});
});
