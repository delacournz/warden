import { afterEach, describe, expect, test } from "bun:test";
import { type TestContext, testContext } from "../testing";
import { runStats, statsCsv } from "./stats";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const NOW = 100_000;

function seed(c: TestContext) {
	c.db.recordEvent({
		at: 1_000,
		type: "requested",
		data: { platform: "ios", profile: "iphone-17", count: 1 },
		claimId: "c1",
	});
	c.db.recordEvent({
		at: 3_000,
		type: "granted",
		data: { platform: "ios", profile: "iphone-17", deviceId: "U1", deviceName: "n", action: "boot", waitMs: 2_000 },
		leaseId: "l1",
	});
	c.db.recordEvent({ at: 13_000, type: "released", data: { heldMs: 10_000 }, leaseId: "l1" });
}

describe("warden stats", () => {
	test("--json carries claims, wait, duration and per-profile peaks", async () => {
		ctx = testContext([], { now: () => NOW });
		seed(ctx);
		expect(runStats(ctx, { json: true })).toBe(0);
		const out = JSON.parse(ctx.stdout.join("\n"));
		expect(out).toMatchObject({
			since: "7d",
			claims: 1,
			wait: { count: 1, medianMs: 2_000, p95Ms: 2_000 },
			duration: { count: 1, medianMs: 10_000 },
			peakConcurrency: 1,
			profiles: [{ platform: "ios", profile: "iphone-17", grants: 1, peakConcurrency: 1 }],
		});
	});

	test("--since leaves out older events", () => {
		ctx = testContext([], { now: () => 7 * 86_400_000 + 10_000 });
		seed(ctx);
		runStats(ctx, { json: true, since: "1h" });
		expect(JSON.parse(ctx.stdout.join("\n")).claims).toBe(0);
	});

	test("--csv prints one metric per row", () => {
		ctx = testContext([], { now: () => NOW });
		seed(ctx);
		expect(runStats(ctx, { csv: true })).toBe(0);
		const lines = ctx.stdout.join("\n").split("\n");
		expect(lines[0]).toBe("scope,platform,profile,metric,value");
		expect(lines).toContain("all,,,wait_median_ms,2000");
		expect(lines).toContain("profile,ios,iphone-17,peak_concurrency,1");
	});

	test("--json with --csv is refused", () => {
		ctx = testContext([], { now: () => NOW });
		expect(runStats(ctx, { json: true, csv: true })).toBe(1);
		expect(ctx.stdout).toEqual([]);
	});

	test("human output names the figures", () => {
		ctx = testContext([], { now: () => NOW });
		seed(ctx);
		runStats(ctx, {});
		const text = ctx.stdout.join("\n");
		expect(text).toContain("claims            1");
		expect(text).toContain("median 2s, p95 2s");
		expect(text).toContain("iphone-17");
	});

	test("csv helper handles empty stats", () => {
		expect(
			statsCsv({
				claims: 0,
				wait: { count: 0, medianMs: 0, p95Ms: 0 },
				duration: { count: 0, medianMs: 0, p95Ms: 0 },
				profiles: [],
				peakConcurrency: 0,
			})
		).toContain("all,,,claims,0");
	});
});
