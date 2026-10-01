import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_TTL_MS } from "@delacour/warden-core/config.defaults";
import { leasePidFor, parseClaimFlags, resolveAutoProfile, resolveOwner } from "./claim-flags";
import { type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe("parseClaimFlags", () => {
	test("defaults", () => {
		const result = parseClaimFlags("ios", {}, 16);
		expect(result).toEqual({
			success: true,
			data: {
				request: { platform: "ios", profile: "iphone-17", count: 1, max: 4 },
				waitMs: 0,
				ttlMs: DEFAULT_TTL_MS,
			},
		});
	});

	test("all flags", () => {
		const result = parseClaimFlags(
			"android",
			{ profile: "pixel-9", runtime: "35", count: "2", max: "3", wait: "10m", ttl: "1h", label: "e2e", adopt: true },
			8
		);
		expect(result).toEqual({
			success: true,
			data: {
				request: { platform: "android", profile: "pixel-9", runtime: "35", count: 2, max: 3, adopt: true },
				waitMs: 600_000,
				ttlMs: 3_600_000,
				label: "e2e",
			},
		});
	});

	test("max defaults to at least count", () => {
		const result = parseClaimFlags("ios", { count: "3" }, 4);
		expect(result.success && result.data.request.max).toBe(3);
	});

	test("rejects bad input", () => {
		expect(parseClaimFlags(undefined, {}).success).toBe(false);
		expect(parseClaimFlags("windows", {}).success).toBe(false);
		expect(parseClaimFlags("ios", { count: "0" }).success).toBe(false);
		expect(parseClaimFlags("ios", { count: "x" }).success).toBe(false);
		expect(parseClaimFlags("ios", { wait: "soon" }).success).toBe(false);
	});
});

describe("resolveOwner", () => {
	test("session env → agent; otherwise user = parent pid", () => {
		ctx = testContext([]);
		expect(resolveOwner({ ...ctx, env: { WARDEN_SESSION_ID: "abc" } })).toMatchObject({
			kind: "agent",
			sessionId: "abc",
		});
		expect(resolveOwner(ctx, "hook-1")).toMatchObject({ kind: "agent", sessionId: "hook-1" });
		const user = resolveOwner(ctx);
		expect(user).toMatchObject({ kind: "user", pid: process.ppid });
		expect(leasePidFor(user)).toBe(process.ppid);
		expect(leasePidFor({ kind: "agent", sessionId: "x", cwd: "/" })).toBeUndefined();
	});
});

describe("resolveAutoProfile", () => {
	test("android auto → first AVD slug", () => {
		expect(resolveAutoProfile(["Pixel_10", "Pixel_9_Pro_Store"])).toEqual({ success: true, data: "pixel-10" });
	});

	test("no AVDs → error", () => {
		expect(resolveAutoProfile([]).success).toBe(false);
	});
});
