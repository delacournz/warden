import { afterEach, describe, expect, test } from "bun:test";
import type { ClaimedDevice } from "@delacour/warden-core/claim";
import { BARE_CLAIM_AGENT_TTL_MS, DEFAULT_TTL_MS } from "@delacour/warden-core/config.defaults";
import type { InventoryDevice, Lease } from "@delacour/warden-core/types";
import {
	bootedByClaim,
	claimWithFlags,
	headlessDeps,
	leasePidFor,
	parseClaimFlags,
	resolveAutoProfile,
	resolveOwner,
} from "./claim-flags";
import type { HideStart } from "./sim-windows";
import { fakeSimctl, OWNER_ENV, wardenSim } from "./simctl.testing";
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

	test("default ttl is overridable by the caller; --ttl still wins", () => {
		const short = parseClaimFlags("ios", {}, 16, BARE_CLAIM_AGENT_TTL_MS);
		expect(short.success && short.data.ttlMs).toBe(5 * 60_000);
		const explicit = parseClaimFlags("ios", { ttl: "1h" }, 16, BARE_CLAIM_AGENT_TTL_MS);
		expect(explicit.success && explicit.data.ttlMs).toBe(60 * 60_000);
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

	test("headless: set only when true", () => {
		const on = parseClaimFlags("ios", { headless: true }, 16);
		expect(on.success && on.data.headless).toBe(true);
		const off = parseClaimFlags("ios", { headless: false }, 16);
		expect(off.success && "headless" in off.data).toBe(false);
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

describe("resolveOwner git facts", () => {
	test("repo and worktree come from the command's git cache, with no git spawn of their own", () => {
		ctx = testContext([]);
		ctx.git.store(ctx.cwd, { toplevel: "/w/app", commonDir: "/w/main/.git", branch: "feat" });
		expect(resolveOwner({ ...ctx, env: { WARDEN_SESSION_ID: "abc" } })).toMatchObject({
			kind: "agent",
			repo: "main",
			worktree: "app@feat",
		});
		expect(resolveOwner(ctx)).toMatchObject({ kind: "user", repo: "main", worktree: "app@feat" });
	});

	test("a cache of another command is not consulted", () => {
		ctx = testContext([]);
		const other = testContext([]);
		try {
			other.git.store(other.cwd, { toplevel: "/w/app", commonDir: "/w/main/.git", branch: "feat" });
			expect(resolveOwner({ ...ctx, cwd: other.cwd })).not.toHaveProperty("repo");
		} finally {
			other.cleanup();
		}
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

describe("bootedByClaim", () => {
	const claimed = (name: string, action: ClaimedDevice["action"], lease: Partial<Lease> = {}): ClaimedDevice => ({
		action,
		device: { platform: "ios", id: `U-${name}`, name, state: "booted", wardenCreated: true } satisfies InventoryDevice,
		lease: { id: `L-${name}`, ...lease } as Lease,
	});

	test("a device that was already running is not one: its window (or lack of one) is already settled", () => {
		expect(bootedByClaim({ claimed: [claimed("a", "reuse")] })).toEqual([]);
	});

	test("booted or created by the claim → its window may still be on its way", () => {
		const outcome = { claimed: [claimed("a", "boot"), claimed("b", "create"), claimed("c", "reuse")] };
		expect(bootedByClaim(outcome).map((c) => c.device.name)).toEqual(["a", "b"]);
	});

	test("a reused device the claim had to boot (it was shut down) counts: the lease says who booted it", () => {
		const outcome = { claimed: [claimed("a", "reuse", { bootedByOwner: true })] };
		expect(bootedByClaim(outcome).map((c) => c.device.name)).toEqual(["a"]);
	});
});

describe("headless hide wiring", () => {
	let hctx: TestContext | undefined;
	afterEach(() => hctx?.cleanup());
	const make = () => {
		hctx = testContext([], { exec: fakeSimctl([wardenSim(1, "Booted")]) });
		hctx.env = { ...hctx.env, ...OWNER_ENV };
		return hctx;
	};

	test("headlessDeps arbitrates Simulator's close setting through the shared store, as this process", () => {
		const c = make();
		const lock = headlessDeps(c).detachLock;
		expect(lock?.store).toBe(c.db);
		expect(lock?.pid).toBe(process.pid);
		expect(lock?.pidAlive(process.pid)).toBe(true);
	});

	test("onHide: a headless iOS claim hands the two-step hide to the caller instead of awaiting its reboots", async () => {
		const c = make();
		const flags = parseClaimFlags("ios", { headless: true }, 16);
		if (!flags.success) throw new Error(flags.error);
		const starts: HideStart[] = [];
		const outcome = await claimWithFlags(c, resolveOwner(c), flags.data, undefined, {
			onHide: (start) => starts.push(start),
		});
		expect(outcome.success).toBe(true);
		expect(starts).toHaveLength(1);
		expect(await starts[0]?.down).toEqual([]);
		expect(await starts[0]?.settled).toMatchObject({ rebooted: [] });
	});

	test("onHide is not called for a claim that tiles instead", async () => {
		const c = make();
		const flags = parseClaimFlags("ios", {}, 16);
		if (!flags.success) throw new Error(flags.error);
		let called = false;
		await claimWithFlags(c, resolveOwner(c), flags.data, undefined, {
			onHide: () => {
				called = true;
			},
		});
		expect(called).toBe(false);
	});
});
