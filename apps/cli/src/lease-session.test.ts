import { afterEach, describe, expect, test } from "bun:test";
import { HEARTBEAT_INTERVAL_MS } from "@delacour/warden-core/config.defaults";
import type { Exec } from "@delacour/warden-core/exec";
import type { InventoryDevice, Lease, Owner } from "@delacour/warden-core/types";
import { type ClaimFlags, parseClaimFlags } from "./claim-flags";
import type { EnsureOptions, PreparedApp } from "./commands/app";
import {
	childEnv,
	claimAll,
	type ForwardedSignal,
	holdLeases,
	INTERRUPTED,
	installLegApp,
	LEASES_LOST,
	type LeaseArgs,
	overlapHide,
	type RunEnsureApp,
	sessionEnsureApp,
	setAfterRebootEnv,
} from "./lease-session";
import type { HideStart } from "./sim-windows";
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

	/**
	 * The boot step of a gated udid (`bootstatus -b`, which boots a shut-down sim, or its `boot` fallback)
	 * waits for `open(udid)`; every boot start is logged once in `events`, in start order.
	 */
	function legSetup(
		sims: Array<ReturnType<typeof sim>>,
		o: { gated?: string[]; bootFails?: string[]; events?: string[] } = {}
	) {
		const events = o.events ?? [];
		const gates = new Map((o.gated ?? []).map((udid) => [udid, Promise.withResolvers<void>()]));
		const base = fakeSimctl(sims);
		const exec: Exec = async (cmd, opts) => {
			if (cmd[0] === "xcrun" && (cmd[2] === "boot" || cmd[2] === "bootstatus")) {
				const udid = cmd[3] ?? "";
				if (!events.includes(`boot:${udid}`)) events.push(`boot:${udid}`);
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

	test("a failed leg releases the other legs' devices only after beforeRelease is done (batch-pipeline R3)", async () => {
		const s = legSetup([sim("U1", "warden-iphone-17-1", "Booted"), sim("P1", "warden-ipad-1", "Shutdown")], {
			bootFails: ["P1"],
		});
		const quiet = Promise.withResolvers<void>();
		let asked = false;
		const beforeRelease = () => {
			asked = true;
			return quiet.promise;
		};
		const running = claimAll(s.ctx, deps(), agent, args({ beforeRelease }), "e2e");
		await waitFor(() => asked);
		expect(s.ctx.db.listLeases()).toHaveLength(1);
		quiet.resolve();
		expect((await running).success).toBe(false);
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

describe("holdLeases", () => {
	/** A context holding port leases `ports` (as `warden run` leaves them): `every` ticks on demand, aborts are recorded. */
	function hold(ports: number[]) {
		const c = testContext([]);
		ctx = c;
		const ids = ports.map(
			(port) => c.db.insertLease({ resource: { kind: "port", port }, owner, ttlMs: 60_000, pid: 4242 }, 0).id
		);
		const ticks: Array<() => void> = [];
		const intervals: number[] = [];
		const aborts: ForwardedSignal[] = [];
		const stop = holdLeases(
			c,
			{
				every: (ms, fn) => {
					intervals.push(ms);
					ticks.push(fn);
					return () => {};
				},
				onSignal: () => () => {},
			},
			ids,
			(signal) => aborts.push(signal)
		);
		const tick = () => {
			for (const fn of ticks) fn();
		};
		return { c, ids, tick, aborts, stop, intervals };
	}

	test("leases released by another process between ticks abort the run once, naming the cause", () => {
		const h = hold([9001, 9002]);
		h.tick();
		expect(h.aborts).toEqual([]);
		h.c.db.deleteLeases([h.ids[1] ?? ""]);
		h.tick();
		h.tick();
		expect(h.aborts).toEqual(["SIGTERM"]);
		expect(h.c.stderr.filter((l) => l.includes(LEASES_LOST))).toHaveLength(1);
		expect(LEASES_LOST).toContain("leases were released by another process: warden release or SessionEnd");
		h.stop();
	});

	test("leases intact: every tick heartbeats, nothing aborts", () => {
		const h = hold([9001]);
		h.tick();
		h.tick();
		expect(h.aborts).toEqual([]);
		expect(h.c.db.getLease(h.ids[0] ?? "")?.heartbeatAt).toBe(1_000_000);
		h.stop();
	});

	test("heartbeats at once and marks the leases supervised with the heartbeat period", () => {
		const h = hold([9001]);
		expect(h.intervals).toEqual([HEARTBEAT_INTERVAL_MS]);
		expect(h.c.db.getLease(h.ids[0] ?? "")).toMatchObject({
			heartbeatAt: 1_000_000,
			heartbeatMs: HEARTBEAT_INTERVAL_MS,
		});
		h.stop();
	});
});

describe("overlapHide (16-8)", () => {
	type Outcome = { closed: string[]; rebooted: string[]; failed?: string[] };
	const hideOf = (down: string[]) => {
		const settled = Promise.withResolvers<Outcome>();
		const start: HideStart = {
			closed: ["U1", "U2"],
			down: Promise.resolve(down.map((udid) => ({ udid, name: `warden-${udid}` }))),
			settled: settled.promise,
		};
		return { start, settle: (outcome: Outcome) => settled.resolve(outcome) };
	};

	test("nothing shut down: the leg is leased and installs before the hide has settled", async () => {
		const { start, settle } = hideOf([]);
		const events: string[] = [];
		const done = overlapHide(start, {
			leased: () => events.push("leased"),
			install: async (ready) => {
				await Promise.all(["U1", "U2"].map((udid) => ready(udid).then(() => events.push(`install:${udid}`))));
				return "ok";
			},
		});
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(events).toEqual(["leased", "install:U1", "install:U2"]);
		settle({ closed: ["U1", "U2"], rebooted: [] });
		expect(await done).toEqual({ result: "ok", failed: [] });
	});

	test("a device the close shut down waits for its reboot; the others install at once", async () => {
		const { start, settle } = hideOf(["U2"]);
		const events: string[] = [];
		const done = overlapHide(start, {
			leased: () => events.push("leased"),
			install: async (ready) => {
				await Promise.all(["U1", "U2"].map((udid) => ready(udid).then(() => events.push(`install:${udid}`))));
				return "ok";
			},
		});
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(events).toEqual(["install:U1"]);
		settle({ closed: ["U1", "U2"], rebooted: ["U2"] });
		expect(await done).toEqual({ result: "ok", failed: [] });
		expect(events).toEqual(["install:U1", "leased", "install:U2"]);
	});

	test("a device that did not come back is reported failed and the leg is never leased", async () => {
		const { start, settle } = hideOf(["U2"]);
		const events: string[] = [];
		const done = overlapHide(start, {
			leased: () => events.push("leased"),
			install: async () => "ok",
		});
		settle({ closed: ["U1", "U2"], rebooted: [], failed: ["U2"] });
		expect(await done).toEqual({ result: "ok", failed: ["U2"] });
		expect(events).toEqual([]);
	});

	test("a device that did not come back is not installed on: its ready says it is down (batch-pipeline R5)", async () => {
		const { start, settle } = hideOf(["U2"]);
		const up: Array<[string, boolean]> = [];
		const done = overlapHide(start, {
			leased: () => {},
			install: async (ready) => {
				for (const udid of ["U1", "U2"]) up.push([udid, await ready(udid)]);
				return "ok";
			},
		});
		settle({ closed: ["U1", "U2"], rebooted: [], failed: ["U2"] });
		expect(await done).toEqual({ result: "ok", failed: ["U2"] });
		expect(up).toEqual([
			["U1", true],
			["U2", false],
		]);
	});

	test("no hide (not headless): leased and installed straight away", async () => {
		const events: string[] = [];
		const done = await overlapHide(undefined, {
			leased: () => events.push("leased"),
			install: async (ready) => {
				await ready("U1");
				events.push("install");
				return 1;
			},
		});
		expect(done).toEqual({ result: 1, failed: [] });
		expect(events).toEqual(["leased", "install"]);
	});
});

describe("setAfterRebootEnv", () => {
	const self = ["/usr/bin/warden"];

	test("non-headless on macOS → the argv that reopens a rebooted sim's window", () => {
		const env: Record<string, string | undefined> = {};
		setAfterRebootEnv(env, false, self, "darwin");
		expect(JSON.parse(env.WARDEN_AFTER_REBOOT ?? "[]")).toEqual(["/usr/bin/warden", "arrange", "--open", "{udid}"]);
	});

	test("headless or not macOS → removed, so children never inherit the parent's", () => {
		const env: Record<string, string | undefined> = { WARDEN_AFTER_REBOOT: '["x"]' };
		setAfterRebootEnv(env, true, self, "darwin");
		expect(env.WARDEN_AFTER_REBOOT).toBeUndefined();
		env.WARDEN_AFTER_REBOOT = '["x"]';
		setAfterRebootEnv(env, false, self, "linux");
		expect(env.WARDEN_AFTER_REBOOT).toBeUndefined();
	});
});

describe("physical devices in a lease session", () => {
	const phone = (platform: "android" | "ios", id: string): ClaimedPhone => ({
		device: {
			platform,
			id,
			name: id,
			state: "booted",
			wardenCreated: false,
			physical:
				platform === "android"
					? { platform, transport: "usb", adbState: "device" }
					: { platform, transport: "wired", deviceType: "iPhone", osVersion: "27.2", developerMode: true, ddi: true },
		},
		lease: { id: `L-${id}` } as Lease,
		action: "reuse",
	});
	const emulator = (): ClaimedPhone => ({
		device: { platform: "android", id: "emulator-5554", name: "e", state: "booted", wardenCreated: true },
		lease: { id: "L-emu" } as Lease,
		action: "reuse",
	});
	type ClaimedPhone = { device: InventoryDevice; lease: Lease; action: "reuse" };
	const IPHONE = "00008140-000A0B0C0D0E0F10";

	test("childEnv: WARDEN_UDIDS carries the serial; WARDEN_DEVICE_KIND=physical only when every device is a phone", () => {
		const only = childEnv(
			{ WARDEN_DEVICE_KIND: "stale" },
			{ claimed: [phone("android", "R5CT1234ABC")], reclaimed: [] },
			[]
		);
		expect(only.WARDEN_UDIDS).toBe("R5CT1234ABC");
		expect(only.WARDEN_UDID_0).toBe("R5CT1234ABC");
		expect(only.WARDEN_DEVICE_KIND).toBe("physical");
		const mixed = childEnv(
			{ WARDEN_DEVICE_KIND: "physical" },
			{ claimed: [phone("android", "R5CT1234ABC"), emulator()], reclaimed: [] },
			[]
		);
		expect(mixed.WARDEN_DEVICE_KIND).toBeUndefined();
	});

	test("an Android phone's install is told it is physical (the ABI check runs); an emulator's is not", async () => {
		ctx = testContext([]);
		const seen: Array<[string, boolean | undefined]> = [];
		const ensure: RunEnsureApp = async (_c, _o, _p, deviceId, o) => {
			seen.push([deviceId, o.physical]);
			return { success: true, data: { appPath: "/c/a.apk", hash: "H", source: "cache", installed: true } };
		};
		const claim = { claimed: [phone("android", "R5CT1234ABC"), emulator()], reclaimed: [] };
		const res = await installLegApp(ctx, ensure, owner, claim, opts);
		expect(res.success).toBe(true);
		expect(seen).toEqual([
			["R5CT1234ABC", true],
			["emulator-5554", undefined],
		]);
	});

	test("an iPhone's install is told it is physical, like an Android phone's", async () => {
		ctx = testContext([]);
		const seen: Array<[string, boolean | undefined]> = [];
		const ensure: RunEnsureApp = async (_c, _o, _p, deviceId, o) => {
			seen.push([deviceId, o.physical]);
			return { success: true, data: { appPath: "/c/a.app", hash: "H", source: "cache", installed: true } };
		};
		const res = await installLegApp(ctx, ensure, owner, { claimed: [phone("ios", IPHONE)], reclaimed: [] }, opts);
		expect(res.success).toBe(true);
		expect(seen).toEqual([[IPHONE, true]]);
	});

	test("sessionEnsureApp prepares a platform's phones and simulators apart (an iPhone's build is signed for a device)", async () => {
		ctx = testContext([]);
		const seen: Array<boolean | undefined> = [];
		const app = sessionEnsureApp({
			prepare: async (_c, o) => {
				seen.push(o.physical);
				return { success: true, data: prepared };
			},
			install: async () => ({ success: true, data: { appPath: "/a", hash: "H", source: "cache", installed: true } }),
		});
		await app.ensure(ctx, owner, "ios", IPHONE, { ...opts, physical: true });
		await app.ensure(ctx, owner, "ios", "SIM-1", opts);
		await app.ensure(ctx, owner, "ios", IPHONE, { ...opts, physical: true });
		expect(seen).toEqual([true, undefined]);
	});
});
