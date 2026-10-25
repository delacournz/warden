import { afterEach, describe, expect, test } from "bun:test";
import type { ClaimedDevice } from "@delacour/warden-core/claim";
import { BARE_CLAIM_AGENT_TTL_MS, DEFAULT_TTL_MS } from "@delacour/warden-core/config.defaults";
import type { Exec } from "@delacour/warden-core/exec";
import { simctlDevicesJson } from "@delacour/warden-core/providers/ios.fixture";
import type { InventoryDevice, Lease } from "@delacour/warden-core/types";
import {
	bootedByClaim,
	claimWithFlags,
	headlessDeps,
	leasePidFor,
	parseClaimFlags,
	resolveAutoProfile,
	resolveOwner,
	resolvePriority,
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
				waitMs: 30 * 60_000,
				ttlMs: DEFAULT_TTL_MS,
				maxDefaulted: true,
			},
		});
	});

	test("--no-wait is fail-fast; --wait overrides the 30m default", () => {
		const none = parseClaimFlags("ios", { wait: false });
		expect(none.success && none.data.waitMs).toBe(0);
		const some = parseClaimFlags("ios", { wait: "2m" });
		expect(some.success && some.data.waitMs).toBe(120_000);
	});

	test("--priority takes names or numbers; the command default is carried, bad input rejected", () => {
		const named = parseClaimFlags("ios", { priority: "high" });
		expect(named.success && named.data.priority).toBe(20);
		const numeric = parseClaimFlags("ios", { priority: "25" });
		expect(numeric.success && numeric.data.priority).toBe(25);
		const fallback = parseClaimFlags("ios", {}, 16, undefined, 0);
		expect(fallback.success && fallback.data.defaultPriority).toBe(0);
		expect(parseClaimFlags("ios", { priority: "urgent" }).success).toBe(false);
	});

	test("resolvePriority: flag beats WARDEN_PRIORITY beats the command default beats normal", () => {
		const flags = (v: Parameters<typeof parseClaimFlags>[1], d?: number) => {
			const r = parseClaimFlags("ios", v, 16, undefined, d);
			if (!r.success) throw new Error(r.error);
			return r.data;
		};
		const env = { WARDEN_PRIORITY: "low" };
		expect(resolvePriority(flags({ priority: "high" }, 0), env)).toEqual({ success: true, data: 20 });
		expect(resolvePriority(flags({}, 20), env)).toEqual({ success: true, data: 0 });
		expect(resolvePriority(flags({}, 20), {})).toEqual({ success: true, data: 20 });
		expect(resolvePriority(flags({}), {})).toEqual({ success: true, data: 10 });
		expect(resolvePriority(flags({}), { WARDEN_PRIORITY: "x" }).success).toBe(false);
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

/**
 * macOS with Simulator.app showing warden-iphone-17-1's window, `DetachOnWindowClose` unset; the rest
 * is `simctl`. The `simctl list` after the close waits for `gate`. Records `defaults`/`osascript` calls.
 */
function macSimulator(simctl: Exec, calls: string[][], gate: Promise<void>): Exec {
	const ok = (stdout = "", exitCode = 0) => ({ exitCode, stdout, stderr: "" });
	const window = { title: "warden-iphone-17-1 – iOS 26.5", width: 456, height: 972 };
	const screen = { x: 0, y: 33, width: 1728, height: 1021 };
	const osascript = (script: string) =>
		ok(script.includes("NSScreen") ? JSON.stringify({ screen, windows: [window] }) : "");
	const defaults = (verb: string | undefined) => (verb === "read" ? ok("", 1) : ok());
	return async (cmd, opts) => {
		if (cmd[0] === "pgrep") return ok();
		if (cmd[0] === "defaults" || cmd[0] === "osascript") calls.push([...cmd]);
		if (cmd[0] === "osascript") return osascript(cmd[4] ?? "");
		if (cmd[0] === "defaults") return defaults(cmd[1]);
		if (cmd.join(" ") === "xcrun simctl list devices -j") {
			// the device states after the close: held until the test has seen the claim return
			await gate;
			return ok(simctlDevicesJson({ "iOS-26-5": [wardenSim(1, "Booted")] }));
		}
		return simctl(cmd, opts);
	};
}

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

	test("onHide on macOS: the claim returns once the windows are closed, before the hide settles", async () => {
		const calls: string[][] = [];
		const simctl = fakeSimctl([wardenSim(1, "Booted")], calls);
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const exec = macSimulator(simctl, calls, gate);
		hctx = testContext([], { exec });
		hctx.env = { ...hctx.env, ...OWNER_ENV };
		const flags = parseClaimFlags("ios", { headless: true }, 16);
		if (!flags.success) throw new Error(flags.error);
		const starts: HideStart[] = [];
		const outcome = await claimWithFlags(hctx, resolveOwner(hctx), flags.data, undefined, {
			onHide: (start) => starts.push(start),
			os: "darwin",
		});
		expect(outcome.success).toBe(true);
		expect(starts[0]?.closed).toEqual(["warden-iphone-17-1"]);
		let settled = false;
		starts[0]?.settled.then(() => {
			settled = true;
		});
		await Bun.sleep(1);
		expect(settled).toBe(false);
		// the close setting is still held: it is put back only once the hide settles
		const defaults = () => calls.filter((c) => c[0] === "defaults").map((c) => c[1]);
		expect(defaults()).toEqual(["read", "write"]);
		release();
		expect(await starts[0]?.settled).toEqual({ closed: ["warden-iphone-17-1"], rebooted: [] });
		expect(defaults()).toEqual(["read", "write", "delete"]);
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

describe("Device Hub windows after a claim (Xcode 27)", () => {
	let dctx: TestContext | undefined;
	afterEach(() => dctx?.cleanup());

	/** Fake `osascript` reply: the screen + one warden window for the NSScreen probe, empty for anything else */
	function osascriptResult(script: string): { exitCode: number; stdout: string; stderr: string } {
		if (!script.includes("NSScreen")) return { exitCode: 0, stdout: "", stderr: "" };
		const screen = { x: 0, y: 25, width: 1440, height: 875 };
		const windows = [{ title: "warden-iphone-17-1 – iOS 27.1", width: 340, height: 751 }];
		return { exitCode: 0, stdout: JSON.stringify({ screen, windows }), stderr: "" };
	}

	/** The fake reply for the process / viewer commands a claim issues, or undefined to fall through to simctl */
	function viewerReply(cmd: readonly string[], running: "DeviceHub" | "none"): Awaited<ReturnType<Exec>> | undefined {
		if (cmd[0] === "pgrep") return { exitCode: cmd[2] === running ? 0 : 1, stdout: "", stderr: "" };
		if (cmd[0] === "open") return { exitCode: 0, stdout: "", stderr: "" };
		if (cmd[0] === "osascript") return osascriptResult(cmd[4] ?? "");
		return undefined;
	}

	/** `pgrep` finds only `running`; every other call goes to simctl; records `open`/`osascript` */
	function viewer(running: "DeviceHub" | "none", calls: string[][]): Exec {
		const simctl = fakeSimctl([wardenSim(1, "Shutdown")], calls);
		return async (cmd, opts) => {
			if (cmd[0] === "open" || cmd[0] === "osascript") calls.push([...cmd]);
			return viewerReply(cmd, running) ?? simctl(cmd, opts);
		};
	}

	async function claim(running: "DeviceHub" | "none", headless: boolean) {
		const calls: string[][] = [];
		dctx = testContext([], { exec: viewer(running, calls) });
		dctx.env = { ...dctx.env, ...OWNER_ENV, WARDEN_ARRANGE: "1" };
		const flags = parseClaimFlags("ios", headless ? { headless: true } : {}, 16);
		if (!flags.success) throw new Error(flags.error);
		const outcome = await claimWithFlags(dctx, resolveOwner(dctx), flags.data, undefined, { os: "darwin" });
		expect(outcome.success).toBe(true);
		return calls.filter((c) => c[0] === "open" || c[0] === "osascript");
	}

	test("non-headless, Device Hub running → a window is opened for the sim the claim booted, then tiled", async () => {
		const calls = await claim("DeviceHub", false);
		const opens = calls.filter((c) => c[0] === "open");
		expect(opens).toHaveLength(1);
		expect(opens[0]?.[1]).toBe("-g");
		expect(opens[0]?.[2]).toMatch(/^devices:\/\/device\/open\?id=/);
		expect(calls.filter((c) => c[0] === "osascript").length).toBeGreaterThanOrEqual(2);
		expect(calls.indexOf(opens[0] as string[])).toBeLessThan(calls.findIndex((c) => c[0] === "osascript"));
	});

	test("non-headless, Device Hub not running → never launched: no open", async () => {
		expect((await claim("none", false)).filter((c) => c[0] === "open")).toEqual([]);
	});

	test("headless, Device Hub running → no window opened, none touched", async () => {
		expect(await claim("DeviceHub", true)).toEqual([]);
	});
});
