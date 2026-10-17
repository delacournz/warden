import { afterEach, describe, expect, test } from "bun:test";
import { fakeApp } from "@delacour/warden-core/builds/builds.testing";
import { storeArtifact } from "@delacour/warden-core/builds/cache";
import { DEFAULT_IDLE_MS } from "@delacour/warden-core/config.defaults";
import type { Owner } from "@delacour/warden-core/types";
import { AUTO_GC_INTERVAL_MS, maybeAutoGc, niceCommand } from "./autogc";
import { type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const agent: Owner = { kind: "agent", sessionId: "a", cwd: "/" };
const NICE = ["nice", "-n", "10"];

/** A context at `clock` whose store holds a lease nobody will ever heartbeat again. */
function withStaleLease(clock: () => number): TestContext {
	const c = testContext([], { now: clock });
	c.env = { ...c.env, WARDEN_BACKGROUND: "1" };
	c.db.insertLease(
		{ resource: { kind: "device", platform: "ios", id: "U1", name: "warden-iphone-17-1" }, owner: agent, ttlMs: 1 },
		0
	);
	return c;
}

describe("maybeAutoGc", () => {
	test("spawns `nice -n 10 gc --quiet` when a lease is stale, at most once per interval (shared across processes via the store)", () => {
		let clock = 5 * AUTO_GC_INTERVAL_MS;
		ctx = withStaleLease(() => clock);
		const spawned: string[][] = [];
		const spawn = (cmd: string[]) => spawned.push(cmd);
		maybeAutoGc(ctx, ["warden"], spawn, { nice: NICE });
		maybeAutoGc(ctx, ["warden"], spawn, { nice: NICE });
		clock += AUTO_GC_INTERVAL_MS;
		maybeAutoGc(ctx, ["warden"], spawn, { nice: NICE });
		expect(spawned).toEqual([
			[...NICE, "warden", "gc", "--quiet"],
			[...NICE, "warden", "gc", "--quiet"],
		]);
	});

	test("no stale lease and no idle device: nothing is spawned, and the check is still throttled", () => {
		let clock = 5 * AUTO_GC_INTERVAL_MS;
		ctx = testContext([], { now: () => clock });
		ctx.env = { ...ctx.env, WARDEN_BACKGROUND: "1" };
		ctx.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "U1", name: "n" }, owner: agent, ttlMs: 60_000 },
			clock
		);
		ctx.db.recordDevice({ platform: "ios", id: "U2", name: "warden-iphone-17-2" }, clock - 60_000);
		const spawned: string[][] = [];
		maybeAutoGc(ctx, ["warden"], (cmd) => spawned.push(cmd), { nice: NICE });
		expect(spawned).toEqual([]);
		expect(ctx.db.getMeta("auto_gc_checked_at")).toBe(String(clock));
		ctx.db.insertLease({ resource: { kind: "port", port: 9 }, owner: agent, ttlMs: 1 }, 0);
		maybeAutoGc(ctx, ["warden"], (cmd) => spawned.push(cmd), { nice: NICE });
		expect(spawned).toEqual([]);
		clock += AUTO_GC_INTERVAL_MS;
		maybeAutoGc(ctx, ["warden"], (cmd) => spawned.push(cmd), { nice: NICE });
		expect(spawned).toHaveLength(1);
	});

	test("a lease whose process is still alive is not stale", () => {
		const clock = 5 * AUTO_GC_INTERVAL_MS;
		ctx = testContext([], { now: () => clock });
		ctx.env = { ...ctx.env, WARDEN_BACKGROUND: "1" };
		ctx.db.insertLease({ resource: { kind: "port", port: 9 }, owner: agent, ttlMs: 1, pid: 4242 }, 0);
		const spawned: string[][] = [];
		maybeAutoGc(ctx, ["warden"], (cmd) => spawned.push(cmd), { nice: NICE, pidAlive: (pid) => pid === 4242 });
		expect(spawned).toEqual([]);
	});

	test("a device that went idle since the last gc is work; once gc has run it is not, until it is used again", () => {
		let clock = 100 * 60_000;
		ctx = testContext([], { now: () => clock });
		ctx.env = { ...ctx.env, WARDEN_BACKGROUND: "1" };
		ctx.db.recordDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1" }, clock - DEFAULT_IDLE_MS);
		const spawned: string[][] = [];
		const spawn = (cmd: string[]) => spawned.push(cmd);
		maybeAutoGc(ctx, ["warden"], spawn, { nice: NICE });
		expect(spawned).toHaveLength(1);
		ctx.db.setMeta("last_gc_at", String(clock));
		clock += AUTO_GC_INTERVAL_MS;
		maybeAutoGc(ctx, ["warden"], spawn, { nice: NICE });
		expect(spawned).toHaveLength(1);
		ctx.db.touchDevice("ios", "U1", clock);
		clock += DEFAULT_IDLE_MS;
		maybeAutoGc(ctx, ["warden"], spawn, { nice: NICE });
		expect(spawned).toHaveLength(2);
	});

	test("a build cache over its cap is work too, even with no stale lease or idle device (R4)", async () => {
		const clock = 5 * AUTO_GC_INTERVAL_MS;
		ctx = testContext([], { now: () => clock });
		ctx.env = { ...ctx.env, WARDEN_BACKGROUND: "1", WARDEN_MAX_CACHE_SIZE: "10" };
		const stored = await storeArtifact({
			store: ctx.db,
			env: ctx.env,
			projectKey: "k",
			platform: "ios",
			profile: "local",
			hash: "h",
			artifact: fakeApp(ctx.cwd),
			source: "build",
			now: clock,
		});
		expect(stored.success).toBe(true);
		const spawned: string[][] = [];
		maybeAutoGc(ctx, ["warden"], (cmd) => spawned.push(cmd), { nice: NICE });
		expect(spawned).toEqual([[...NICE, "warden", "gc", "--quiet"]]);
	});

	test("a cache under its cap (or a bad WARDEN_MAX_CACHE_SIZE, which gc would not prune with) is no work (R4)", async () => {
		let clock = 5 * AUTO_GC_INTERVAL_MS;
		ctx = testContext([], { now: () => clock });
		ctx.env = { ...ctx.env, WARDEN_BACKGROUND: "1" };
		await storeArtifact({
			store: ctx.db,
			env: ctx.env,
			projectKey: "k",
			platform: "ios",
			profile: "local",
			hash: "h",
			artifact: fakeApp(ctx.cwd),
			source: "build",
			now: clock,
		});
		const spawned: string[][] = [];
		maybeAutoGc(ctx, ["warden"], (cmd) => spawned.push(cmd), { nice: NICE });
		clock += AUTO_GC_INTERVAL_MS;
		ctx.env = { ...ctx.env, WARDEN_MAX_CACHE_SIZE: "tiny" };
		maybeAutoGc(ctx, ["warden"], (cmd) => spawned.push(cmd), { nice: NICE });
		expect(spawned).toEqual([]);
	});

	test("WARDEN_AUTO_GC=0 and WARDEN_BACKGROUND=0 disable it, without even checking", () => {
		ctx = withStaleLease(() => 5 * AUTO_GC_INTERVAL_MS);
		ctx.env = { ...ctx.env, WARDEN_AUTO_GC: "0" };
		const spawned: string[][] = [];
		maybeAutoGc(ctx, ["warden"], (cmd) => spawned.push(cmd), { nice: NICE });
		ctx.env = { ...ctx.env, WARDEN_AUTO_GC: "1", WARDEN_BACKGROUND: "0" };
		maybeAutoGc(ctx, ["warden"], (cmd) => spawned.push(cmd), { nice: NICE });
		expect(spawned).toEqual([]);
		expect(ctx.db.getMeta("auto_gc_checked_at")).toBeUndefined();
	});

	test("no `nice` on this machine: the pass is spawned as it was", () => {
		ctx = withStaleLease(() => 5 * AUTO_GC_INTERVAL_MS);
		const spawned: string[][] = [];
		maybeAutoGc(ctx, ["warden"], (cmd) => spawned.push(cmd), { nice: [] });
		expect(spawned).toEqual([["warden", "gc", "--quiet"]]);
	});
});

describe("niceCommand", () => {
	test("`nice -n 10` where `nice` exists, nothing where it does not", () => {
		expect(niceCommand(() => "/usr/bin/nice")).toEqual(NICE);
		expect(niceCommand(() => null)).toEqual([]);
		expect(niceCommand(() => undefined)).toEqual([]);
	});
});
