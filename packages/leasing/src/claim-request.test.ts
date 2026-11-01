import { afterEach, describe, expect, test } from "bun:test";
import { simctlFixtures } from "@delacour/warden-providers/testing/ios.fixture";
import { OWNER_ENV, simctlFakes } from "@delacour/warden-providers/testing/simctl.testing";
import type { Exec } from "@delacour/warden-runtime/exec";
import type { InventoryDevice, Lease } from "@delacour/warden-store/types";
import type { ClaimedDevice } from "./claim";
import {
	bootedByClaim,
	type ClaimRequest,
	claimedJson,
	claimWithRequest,
	headlessDeps,
	resolveAutoProfile,
	resolvePriority,
} from "./claim-request";
import { resolveOwner } from "./owner";
import type { HideStart } from "./sim-windows";
import { type TestLeaseHost, testLeaseHost } from "./testing/lease-host.testing";

let ctx: TestLeaseHost | undefined;
afterEach(() => ctx?.cleanup());

/** A minimal ios claim request with the given extras. */
function flags(extra: Partial<ClaimRequest> = {}): ClaimRequest {
	return {
		request: { platform: "ios", profile: "iphone-17", count: 1, max: 4 },
		waitMs: 30 * 60_000,
		ttlMs: 30 * 60_000,
		...extra,
	};
}

describe("resolvePriority", () => {
	test("flag beats WARDEN_PRIORITY beats the command default beats normal", () => {
		const env = { WARDEN_PRIORITY: "low" };
		expect(resolvePriority(flags({ priority: 20, defaultPriority: 0 }), env)).toEqual({ success: true, data: 20 });
		expect(resolvePriority(flags({ defaultPriority: 20 }), env)).toEqual({ success: true, data: 0 });
		expect(resolvePriority(flags({ defaultPriority: 20 }), {})).toEqual({ success: true, data: 20 });
		expect(resolvePriority(flags(), {})).toEqual({ success: true, data: 10 });
		expect(resolvePriority(flags(), { WARDEN_PRIORITY: "x" }).success).toBe(false);
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
			return ok(simctlFixtures.devicesJson({ "iOS-26-5": [simctlFakes.wardenSim(1, "Booted")] }));
		}
		return simctl(cmd, opts);
	};
}

describe("headless hide wiring", () => {
	let hctx: TestLeaseHost | undefined;
	afterEach(() => hctx?.cleanup());
	const make = () => {
		hctx = testLeaseHost({ exec: simctlFakes.build([simctlFakes.wardenSim(1, "Booted")]) });
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
		const req = flags({ headless: true });
		const starts: HideStart[] = [];
		const outcome = await claimWithRequest(c, resolveOwner(c), req, undefined, {
			onHide: (start) => starts.push(start),
		});
		expect(outcome.success).toBe(true);
		expect(starts).toHaveLength(1);
		expect(await starts[0]?.down).toEqual([]);
		expect(await starts[0]?.settled).toMatchObject({ rebooted: [] });
	});

	test("onHide on macOS: the claim returns once the windows are closed, before the hide settles", async () => {
		const calls: string[][] = [];
		const simctl = simctlFakes.build([simctlFakes.wardenSim(1, "Booted")], calls);
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const exec = macSimulator(simctl, calls, gate);
		hctx = testLeaseHost({ exec });
		hctx.env = { ...hctx.env, ...OWNER_ENV };
		const req = flags({ headless: true });
		const starts: HideStart[] = [];
		const outcome = await claimWithRequest(hctx, resolveOwner(hctx), req, undefined, {
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
		const req = flags();
		let called = false;
		await claimWithRequest(c, resolveOwner(c), req, undefined, {
			onHide: () => {
				called = true;
			},
		});
		expect(called).toBe(false);
	});
});

describe("Device Hub windows after a claim (Xcode 27)", () => {
	let dctx: TestLeaseHost | undefined;
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
		const simctl = simctlFakes.build([simctlFakes.wardenSim(1, "Shutdown")], calls);
		return async (cmd, opts) => {
			if (cmd[0] === "open" || cmd[0] === "osascript") calls.push([...cmd]);
			return viewerReply(cmd, running) ?? simctl(cmd, opts);
		};
	}

	async function claim(running: "DeviceHub" | "none", headless: boolean) {
		const calls: string[][] = [];
		dctx = testLeaseHost({ exec: viewer(running, calls) });
		dctx.env = { ...dctx.env, ...OWNER_ENV, WARDEN_ARRANGE: "1" };
		const outcome = await claimWithRequest(
			dctx,
			resolveOwner(dctx),
			flags(headless ? { headless: true } : {}),
			undefined,
			{ os: "darwin" }
		);
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

describe("claim options handed to the host", () => {
	test("an iOS claim passes the resolved slim profile and physical options to providerFor", async () => {
		const seen: unknown[] = [];
		const simctl = simctlFakes.build([simctlFakes.wardenSim(1, "Booted")], []);
		const c = testLeaseHost({ exec: simctl });
		ctx = c;
		const inner = c.providerFor;
		c.providerFor = (platform, owner, opts) => {
			seen.push(opts);
			return inner(platform, owner, opts);
		};
		await claimWithRequest(c, resolveOwner(c), flags({ slim: { flag: false }, headless: true }), undefined, {
			os: "linux",
		});
		expect(seen[0]).toEqual({ slim: false, physical: false });
	});

	test("a bad slim setting fails the claim before any device is touched", async () => {
		const c = testLeaseHost();
		ctx = c;
		const outcome = await claimWithRequest(
			c,
			resolveOwner(c),
			flags({ slim: { config: { keep: ["no-such-label"] } } }),
			undefined
		);
		expect(outcome.success).toBe(false);
		expect(c.db.listLeases()).toEqual([]);
	});
});

describe("claimedJson", () => {
	const lease = (resource: Lease["resource"]): Lease => ({
		id: "l1",
		resource,
		owner: { kind: "agent", sessionId: "s", cwd: "/" },
		ttlMs: 1000,
		acquiredAt: 0,
		heartbeatAt: 0,
	});
	const device: InventoryDevice = {
		platform: "android",
		id: "R5",
		name: "Pixel",
		state: "booted",
		wardenCreated: false,
	};

	test("a phone's lease carries its physical facts; a virtual device's does not", () => {
		const phone = lease({
			kind: "device",
			platform: "android",
			id: "R5",
			name: "Pixel",
			physical: { transport: "usb" },
		});
		const virtual = lease({ kind: "device", platform: "android", id: "R5", name: "Pixel" });
		const json = claimedJson({
			reclaimed: [],
			claimed: [
				{ device, lease: phone, action: "reuse" },
				{ device, lease: virtual, action: "reuse" },
			],
		});
		expect(json[0]?.physical).toEqual({ transport: "usb" });
		expect("physical" in (json[1] ?? {})).toBe(false);
	});
});
