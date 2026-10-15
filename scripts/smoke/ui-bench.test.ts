import { describe, expect, test } from "bun:test";
import { overTolerance, parseArgs, parseBench, parseClaim } from "./ui-bench";

describe("parseArgs", () => {
	test("defaults and flags", () => {
		expect(parseArgs([])).toEqual({ platform: "ios", bundle: "nz.co.delacour.warden.example" });
		expect(parseArgs(["--udid", "X", "--platform", "android", "--runs", "5", "--bundle", "a.b"])).toEqual({
			udid: "X",
			platform: "android",
			bundle: "a.b",
			runs: "5",
		});
	});

	test("rejects unknown flags, missing values and bad platforms", () => {
		expect(parseArgs(["--nope"])).toBe("unknown argument --nope");
		expect(parseArgs(["--udid"])).toBe("--udid needs a value");
		expect(parseArgs(["--platform", "tv"])).toBe("--platform must be ios or android, got tv");
	});
});

describe("parseClaim", () => {
	test("takes the first claimed device's lease id and udid", () => {
		expect(
			parseClaim(
				JSON.stringify({
					leases: [
						{ leaseId: "L1", udid: "U1" },
						{ leaseId: "L2", udid: "U2" },
					],
				})
			)
		).toEqual({
			leaseId: "L1",
			udid: "U1",
		});
		expect(parseClaim("nope")).toBeUndefined();
		expect(parseClaim("[]")).toBeUndefined();
		expect(parseClaim(JSON.stringify({ leases: [] }))).toBeUndefined();
	});
});

describe("parseBench and overTolerance", () => {
	const doc = {
		ok: true,
		result: {
			metrics: {
				snapshotWarm: { p50: 50, p95: 60, samples: 3, targetMs: 60, ok: true },
				pressHid: { p50: 90, p95: 95, samples: 3, targetMs: 30, ok: false },
				tree: { skipped: "devtools_unavailable", samples: 0 },
			},
		},
	};

	test("reads the metrics and names the ones over target x1.5", () => {
		const parsed = parseBench(JSON.stringify(doc));
		if ("error" in parsed) throw new Error(parsed.error);
		expect(overTolerance(parsed.metrics)).toEqual(["pressHid"]);
	});

	test("an error envelope or garbage is an error", () => {
		expect(parseBench(JSON.stringify({ ok: false, error: { code: "usage", message: "x" } }))).toHaveProperty("error");
		expect(parseBench("boom")).toHaveProperty("error");
	});
});
