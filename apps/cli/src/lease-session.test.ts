import { afterEach, describe, expect, test } from "bun:test";
import type { Exec } from "@delacour/warden-core/exec";
import type { Owner } from "@delacour/warden-core/types";
import { type ClaimFlags, parseClaimFlags } from "./claim-flags";
import type { EnsureOptions, PreparedApp } from "./commands/app";
import { claimAll, INTERRUPTED, type LeaseArgs, type RunEnsureApp, sessionEnsureApp } from "./lease-session";
import { fakeSimctl } from "./simctl.testing";
import { type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const owner: Owner = { kind: "ci", runId: "r1" };
const opts: EnsureOptions = { project: "/p", eas: false, build: false };
const prepared = { project: { root: "/p" }, hash: "H" } as unknown as PreparedApp;

describe("sessionEnsureApp", () => {
	test("warm() fingerprints once per platform; every device's ensure reuses it", async () => {
		ctx = testContext([]);
		const prepares: string[] = [];
		const installs: string[] = [];
		const gate = Promise.withResolvers<void>();
		const session = sessionEnsureApp({
			prepare: async (_ctx, _opts, platform) => {
				prepares.push(platform);
				await gate.promise;
				return { success: true, data: prepared };
			},
			install: async (_ctx, _owner, _platform, deviceId, _opts, app) => {
				installs.push(`${deviceId}:${app.hash}`);
				return { success: true, data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true } };
			},
		});
		session.warm(ctx, opts, "ios");
		session.warm(ctx, opts, "ios");
		expect(prepares).toEqual(["ios"]);
		const ensures = Promise.all([
			session.ensure(ctx, owner, "ios", "U1", opts),
			session.ensure(ctx, owner, "ios", "U2", opts),
		]);
		expect(installs).toEqual([]);
		gate.resolve();
		const results = await ensures;
		expect(results.every((r) => r.success)).toBe(true);
		expect(prepares).toEqual(["ios"]);
		expect(installs.sort()).toEqual(["U1:H", "U2:H"]);
	});

	test("a fingerprint that fails during warm() is what every ensure reports; nothing is installed", async () => {
		ctx = testContext([]);
		const installs: string[] = [];
		const session = sessionEnsureApp({
			prepare: async () => ({ success: false, error: "no fingerprint" }),
			install: async (_ctx, _owner, _platform, deviceId) => {
				installs.push(deviceId);
				return { success: true, data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true } };
			},
		});
		session.warm(ctx, opts, "android");
		const res = await session.ensure(ctx, owner, "android", "E1", opts);
		expect(res).toEqual({ success: false, error: "no fingerprint" });
		expect(installs).toEqual([]);
	});
});

describe("claimAll with device legs", () => {
	const sim = (udid: string, name: string, state: "Booted" | "Shutdown") => ({ udid, name, state });
	const flagsOf = (profile: string): ClaimFlags => {
		const parsed = parseClaimFlags("ios", { profile }, 16);
		if (!parsed.success) throw new Error(parsed.error);
		return parsed.data;
	};
	const legFlags = [flagsOf("iphone-17"), flagsOf("ipad")];
	const agent: Owner = { kind: "agent", sessionId: "me", cwd: "/" };
	const installed = { appPath: "/c/A.app", hash: "H", source: "cache" as const, installed: true };

	/** `boot` of a gated udid waits for `open(udid)`; every boot start is logged in `events`, in start order. */
	function legSetup(
		sims: Array<ReturnType<typeof sim>>,
		o: { gated?: string[]; bootFails?: string[]; events?: string[] } = {}
	) {
		const events = o.events ?? [];
		const gates = new Map((o.gated ?? []).map((udid) => [udid, Promise.withResolvers<void>()]));
		const base = fakeSimctl(sims);
		const exec: Exec = async (cmd, opts) => {
			if (cmd[0] === "xcrun" && cmd[2] === "boot") {
				const udid = cmd[3] ?? "";
				events.push(`boot:${udid}`);
				await gates.get(udid)?.promise;
				if (o.bootFails?.includes(udid)) return { exitCode: 1, stdout: "", stderr: "boot failed" };
			}
			return base(cmd, opts);
		};
		ctx = testContext([], { exec });
		return { ctx, events, open: (udid: string) => gates.get(udid)?.resolve() };
	}

	async function waitFor(cond: () => boolean): Promise<void> {
		for (let i = 0; i < 500 && !cond(); i++) await Bun.sleep(1);
	}

	const args = (extra: Partial<LeaseArgs> = {}): LeaseArgs => ({
		flags: legFlags[0] as ClaimFlags,
		legFlags,
		ports: [],
		...extra,
	});
	const deps = (ensureApp?: RunEnsureApp) => ({
		pid: process.pid,
		isPortFree: async () => true,
		...(ensureApp ? { ensureApp } : {}),
	});
	const twoShutdown = () => [sim("U1", "warden-iphone-17-1", "Shutdown"), sim("P1", "warden-ipad-1", "Shutdown")];

	test("every leg is claimed at once: the second boot starts before the first has finished", async () => {
		const s = legSetup(twoShutdown(), { gated: ["U1", "P1"] });
		const running = claimAll(s.ctx, deps(), agent, args(), "e2e");
		await waitFor(() => s.events.length === 2);
		expect([...s.events].sort()).toEqual(["boot:P1", "boot:U1"]);
		s.open("P1");
		s.open("U1");
		const session = await running;
		if (!session.success) throw new Error(session.error);
		expect(session.data.claims.map((c) => c.claimed.map((d) => d.device.id))).toEqual([["U1"], ["P1"]]);
		expect(session.data.outcome.claimed.map((d) => d.device.id)).toEqual(["U1", "P1"]);
	});

	test("a leg's app install starts when that leg is claimed, not when the slowest leg is", async () => {
		const events: string[] = [];
		const s = legSetup([sim("U1", "warden-iphone-17-1", "Booted"), sim("P1", "warden-ipad-1", "Shutdown")], {
			gated: ["P1"],
			events,
		});
		const running = claimAll(
			s.ctx,
			deps(async (_c, _o, _p, deviceId) => {
				events.push(`ensure:${deviceId}`);
				return { success: true, data: installed };
			}),
			agent,
			args({ app: opts }),
			"e2e"
		);
		await waitFor(() => events.includes("ensure:U1"));
		expect(events).toContain("ensure:U1");
		expect(events).toContain("boot:P1");
		expect(events).not.toContain("ensure:P1");
		s.open("P1");
		const session = await running;
		expect(session.success).toBe(true);
		expect(events.indexOf("ensure:U1")).toBeLessThan(events.indexOf("ensure:P1"));
	});

	test("WARDEN_APP_PATH / WARDEN_APP_HASH come from the last device in claim order, however the installs finish", async () => {
		const s = legSetup([sim("U1", "warden-iphone-17-1", "Booted"), sim("P1", "warden-ipad-1", "Booted")]);
		const gate = Promise.withResolvers<void>();
		const session = await claimAll(
			s.ctx,
			deps(async (_c, _o, _p, deviceId) => {
				if (deviceId === "P1") await gate.promise;
				else gate.resolve();
				return { success: true, data: { ...installed, appPath: `/c/${deviceId}.app`, hash: `H-${deviceId}` } };
			}),
			agent,
			args({ app: opts }),
			"e2e"
		);
		if (!session.success) throw new Error(session.error);
		expect(session.data.env.WARDEN_APP_PATH).toBe("/c/P1.app");
		expect(session.data.env.WARDEN_APP_HASH).toBe("H-P1");
		expect(s.ctx.stderr.filter((l) => l.includes("app cache on"))).toEqual([
			"warden e2e: app cache on U1 [H-U1]",
			"warden e2e: app cache on P1 [H-P1]",
		]);
	});

	test("onLeased reports each leg, with its index, as it is held", async () => {
		const s = legSetup([sim("U1", "warden-iphone-17-1", "Booted"), sim("P1", "warden-ipad-1", "Booted")]);
		const leased: string[][] = [];
		const session = await claimAll(
			s.ctx,
			deps(),
			agent,
			args({ onLeased: (o, leg) => leased.push([String(leg), ...o.claimed.map((d) => d.device.id)]) }),
			"e2e"
		);
		expect(session.success).toBe(true);
		expect(leased.map((l) => l.join(":")).sort()).toEqual(["0:U1", "1:P1"]);
	});

	test("one leg failing waits for the others to land, then releases every lease it took", async () => {
		const s = legSetup(twoShutdown(), { gated: ["P1"], bootFails: ["U1"] });
		let settled = false;
		const running = claimAll(s.ctx, deps(), agent, args({ ports: [] }), "e2e").then((r) => {
			settled = true;
			return r;
		});
		await waitFor(() => s.events.length === 2);
		await Bun.sleep(20);
		expect(settled).toBe(false);
		s.open("P1");
		const session = await running;
		expect(session.success).toBe(false);
		if (!session.success) expect(session.error).toContain("boot failed");
		expect(s.ctx.db.listLeases()).toEqual([]);
	});

	test("an install failing on one leg releases every leg's devices and the ports", async () => {
		const s = legSetup([sim("U1", "warden-iphone-17-1", "Booted"), sim("P1", "warden-ipad-1", "Booted")]);
		const session = await claimAll(
			s.ctx,
			deps(async (_c, _o, _p, deviceId) =>
				deviceId === "P1" ? { success: false, error: "no build" } : { success: true, data: installed }
			),
			agent,
			args({ app: opts, ports: ["9000:5"] }),
			"e2e"
		);
		expect(session).toEqual({ success: false, error: "app on P1: no build" });
		expect(s.ctx.db.listLeases()).toEqual([]);
	});

	test("aborted before the claim: nothing is booted, interrupted, ports released", async () => {
		const s = legSetup(twoShutdown());
		const session = await claimAll(s.ctx, deps(), agent, args({ aborted: () => true, ports: ["9000:5"] }), "e2e");
		expect(session).toEqual({ success: false, error: INTERRUPTED });
		expect(s.events).toEqual([]);
		expect(s.ctx.db.listLeases()).toEqual([]);
	});

	test("aborted while the legs boot: no install starts, everything is released", async () => {
		const events: string[] = [];
		const s = legSetup(twoShutdown(), { gated: ["U1", "P1"], events });
		let abort = false;
		const running = claimAll(
			s.ctx,
			deps(async (_c, _o, _p, deviceId) => {
				events.push(`ensure:${deviceId}`);
				return { success: true, data: installed };
			}),
			agent,
			args({ app: opts, aborted: () => abort }),
			"e2e"
		);
		await waitFor(() => events.length === 2);
		abort = true;
		s.open("U1");
		s.open("P1");
		expect(await running).toEqual({ success: false, error: INTERRUPTED });
		expect(events.filter((e) => e.startsWith("ensure:"))).toEqual([]);
		expect(s.ctx.db.listLeases()).toEqual([]);
	});

	test("a single claim (no legs) behaves as before", async () => {
		const s = legSetup([sim("U1", "warden-iphone-17-1", "Booted")]);
		const session = await claimAll(
			s.ctx,
			deps(async () => ({ success: true, data: installed })),
			agent,
			{ flags: legFlags[0] as ClaimFlags, ports: [], app: opts },
			"e2e"
		);
		if (!session.success) throw new Error(session.error);
		expect(session.data.claims).toHaveLength(1);
		expect(session.data.env.WARDEN_APP_HASH).toBe("H");
	});
});
