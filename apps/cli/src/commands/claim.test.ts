import { afterEach, describe, expect, test } from "bun:test";
import { PHONE_PROBE_SCRIPT } from "@delacour/warden-core/providers/android";
import { PHONE_PROPS } from "@delacour/warden-core/providers/android.fixtures";
import {
	DEVICECTL_LOCKSTATE_LOCKED,
	devicectlEntry,
	devicectlJson,
	FAKE_IPHONE_UDID,
} from "@delacour/warden-core/providers/devicectl.fixtures";
import { simctlDevicesJson } from "@delacour/warden-core/providers/ios.fixture";
import { DEFAULT_SLIM_PROFILE, desiredLabels } from "@delacour/warden-core/sims/slim.profile";
import { allowAutoGc, autoGcConsidered, autoGcOrder } from "../autogc.testing";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { fakeExec, type ScriptedUi, scriptedUi, type TestContext, testContext } from "../testing";
import { claimCommand } from "./claim";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function setup(argv: string[], exec = fakeSimctl([wardenSim(1), wardenSim(2, "Booted")])): TestContext {
	ctx = testContext(argv, { exec });
	ctx.env = { ...ctx.env, ...OWNER_ENV };
	return ctx;
}

describe("warden claim", () => {
	test("claims a booted warden sim first, --json output", async () => {
		const c = setup(["ios", "--json", "--label", "e2e"]);
		expect(await claimCommand.run(c)).toBe(0);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.udids).toEqual(["U2"]);
		expect(out.leases[0]).toMatchObject({ udid: "U2", name: "warden-iphone-17-2", action: "reuse", label: "e2e" });
		const [lease] = c.db.listLeases();
		expect(lease?.owner).toMatchObject({ kind: "agent", sessionId: "me" });
		expect(lease?.pid).toBeUndefined();
	});

	test("--count 2 boots the shutdown one; text output lists udids", async () => {
		const calls: string[][] = [];
		const c = setup(["ios", "--count", "2"], fakeSimctl([wardenSim(1), wardenSim(2, "Booted")], calls));
		expect(await claimCommand.run(c)).toBe(0);
		expect(calls.map((x) => x.join(" "))).toContain("xcrun simctl bootstatus U1 -b");
		const text = c.stdout.join("\n");
		expect(text).toContain("U1");
		expect(text).toContain("U2");
	});

	test("agent bare claim → 5m ttl + stderr hint; stdout stays pure JSON", async () => {
		const c = setup(["ios", "--json"]);
		expect(await claimCommand.run(c)).toBe(0);
		expect(c.db.listLeases()[0]?.ttlMs).toBe(5 * 60_000);
		expect(c.stderr.join("\n")).toContain("lease expires in 5m; hold it with: warden dev");
		expect(() => JSON.parse(c.stdout.join("\n"))).not.toThrow();
	});

	test("agent --ttl overrides the default, no hint", async () => {
		const c = setup(["ios", "--ttl", "20m"]);
		expect(await claimCommand.run(c)).toBe(0);
		expect(c.db.listLeases()[0]?.ttlMs).toBe(20 * 60_000);
		expect(c.stderr.join("\n")).not.toContain("lease expires");
	});

	test("user owner → 30m ttl, no hint", async () => {
		ctx = testContext(["ios"], { exec: fakeSimctl([wardenSim(1, "Booted")]) });
		expect(await claimCommand.run(ctx)).toBe(0);
		expect(ctx.db.listLeases()[0]?.ttlMs).toBe(30 * 60_000);
		expect(ctx.stderr.join("\n")).not.toContain("lease expires");
	});

	test("user owner → lease pid = parent shell", async () => {
		ctx = testContext(["ios"], { exec: fakeSimctl([wardenSim(1, "Booted")]) });
		expect(await claimCommand.run(ctx)).toBe(0);
		expect(ctx.db.listLeases()[0]?.pid).toBe(process.ppid);
	});

	test("pool exhausted → exit 1 with guidance", async () => {
		const c = setup(["ios", "--max", "1", "--no-wait"], fakeSimctl([wardenSim(1, "Booted")]));
		c.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "U1", name: "warden-iphone-17-1" },
				owner: { kind: "agent", sessionId: "other", cwd: "/" },
				ttlMs: 60_000,
			},
			c.now()
		);
		expect(await claimCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("all 1 warden-iphone-17 devices leased; max 1");
	});

	test("a full host queues: the progress line is on stderr and --json stdout is the failure envelope", async () => {
		const c = setup(
			["ios", "--json", "--no-wait", "--priority", "high"],
			fakeSimctl([wardenSim(1, "Booted"), wardenSim(2)])
		);
		c.env = { ...c.env, WARDEN_CAPACITY_MAX: "1" };
		c.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "U1", name: "warden-iphone-17-1" },
				owner: { kind: "agent", sessionId: "other", cwd: "/" },
				ttlMs: 60_000,
			},
			c.now()
		);
		expect(await claimCommand.run(c)).toBe(1);
		expect(c.stdout).toHaveLength(1);
		expect(JSON.parse(c.stdout[0] ?? "")).toMatchObject({ ok: false, command: "claim", error: { code: "failed" } });
		// withSpinner routes ctx.err progress through spinner.log, which the real UI writes to stderr
		expect((c.ui as ScriptedUi).events.join("\n")).toMatch(/log: warden: queued #1 of 1 \(high\) — no room, /);
		expect(c.db.listQueue()).toEqual([]);
	});

	test("WARDEN_CAPACITY=off never queues", async () => {
		const c = setup(["ios", "--json", "--no-wait"], fakeSimctl([wardenSim(1, "Booted"), wardenSim(2)]));
		c.env = { ...c.env, WARDEN_CAPACITY_MAX: "1", WARDEN_CAPACITY: "off" };
		c.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "U1", name: "warden-iphone-17-1" },
				owner: { kind: "agent", sessionId: "other", cwd: "/" },
				ttlMs: 60_000,
			},
			c.now()
		);
		expect(await claimCommand.run(c)).toBe(0);
		expect((c.ui as ScriptedUi).events.join("\n")).not.toContain("queued #");
	});

	test("bad flags → exit 1", async () => {
		const c = setup(["tvos"]);
		expect(await claimCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("unknown platform");
		const d = setup(["ios", "--bogus"]);
		expect(await claimCommand.run(d)).toBe(1);
	});

	test("no platform in a terminal → asks; spinner covers the claim", async () => {
		const c = setup(["--json"]);
		const ui = scriptedUi({ interactive: true, select: ["ios"] });
		c.ui = ui;
		expect(await claimCommand.run(c)).toBe(0);
		expect(ui.events[0]).toBe("select: Which platform?");
		expect(ui.events.some((e) => e.startsWith("ok: claimed"))).toBe(true);
		expect(JSON.parse(c.stdout.join("\n")).leases).toHaveLength(1);
	});

	test("picker cancelled → exit 1, nothing claimed", async () => {
		const c = setup([]);
		c.ui = scriptedUi({ interactive: true, select: [undefined] });
		expect(await claimCommand.run(c)).toBe(1);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("unknown option → commander usage error, exit 1", async () => {
		const c = setup(["ios", "--bogus"]);
		expect(await claimCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("unknown option '--bogus'");
	});
});

describe("warden claim → arrange", () => {
	test("iOS claim tiles sim windows unless WARDEN_ARRANGE=0", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], fakeSimctl([wardenSim(1, "Booted")], calls, [["osascript", { stdout: "{}" }]]));
		const { WARDEN_ARRANGE: _, ...env } = c.env;
		c.env = env;
		expect(await claimCommand.run(c)).toBe(0);
		expect(calls.some((cmd) => cmd[0] === "osascript")).toBe(process.platform === "darwin");
	});

	const windowOf = (name: string) =>
		JSON.stringify({
			screen: { x: 0, y: 25, width: 1000, height: 1000 },
			windows: [{ title: `${name} – iOS 26.5`, width: 400, height: 800 }],
		});
	const headlessSetup = (argv: string[], env: Record<string, string> = {}) => {
		const calls: string[][] = [];
		const c = setup(
			argv,
			fakeSimctl([wardenSim(2, "Booted")], calls, [
				["osascript", { stdout: windowOf("warden-iphone-17-2") }],
				["xcrun simctl list devices -j", { stdout: simctlDevicesJson({ "iOS-26-5": [wardenSim(2, "Booted")] }) }],
			])
		);
		const { WARDEN_ARRANGE: _, ...rest } = c.env;
		c.env = { ...rest, ...env };
		const scripts = () => calls.filter((cmd) => cmd[0] === "osascript").map((cmd) => cmd[4] ?? "");
		return { c, scripts };
	};
	const darwin = process.platform === "darwin";

	test("--headless closes the claimed sim's window instead of tiling", async () => {
		const { c, scripts } = headlessSetup(["ios", "--headless"]);
		expect(await claimCommand.run(c)).toBe(0);
		expect(scripts().some((s) => s.includes("AXCloseButton"))).toBe(darwin);
		expect(scripts().some((s) => s.includes("AXRaise"))).toBe(false);
	});

	test("WARDEN_HEADLESS=1 is the fallback; --no-headless beats it", async () => {
		const env = headlessSetup(["ios"], { WARDEN_HEADLESS: "1" });
		expect(await claimCommand.run(env.c)).toBe(0);
		expect(env.scripts().some((s) => s.includes("AXCloseButton"))).toBe(darwin);
		env.c.cleanup();
		const off = headlessSetup(["ios", "--no-headless"], { WARDEN_HEADLESS: "1" });
		expect(await claimCommand.run(off.c)).toBe(0);
		expect(off.scripts().some((s) => s.includes("AXCloseButton"))).toBe(false);
	});

	const printed = (labels: Iterable<string>): string =>
		`disabled services = {\n${[...labels].map((l) => `\t"${l}" => disabled`).join("\n")}\n}\n`;

	const slimSpawns = (calls: string[][]): boolean =>
		calls.some((x) => x.includes("print-disabled") || x.includes("disable") || x.includes("enable"));

	test("a recorded, already-booted sim that was never slimmed is slimmed live and recorded", async () => {
		const calls: string[][] = [];
		const exec = fakeSimctl([wardenSim(2, "Booted")], calls, [
			["xcrun simctl spawn U2 launchctl print-disabled", { stdout: printed(desiredLabels(DEFAULT_SLIM_PROFILE)) }],
		]);
		const c = setup(["ios"], exec);
		c.db.recordDevice({ platform: "ios", id: "U2", name: "warden-iphone-17-2", profile: "iphone-17" }, 0);
		expect(await claimCommand.run(c)).toBe(0);
		expect(calls.some((x) => x.includes("print-disabled"))).toBe(true);
		expect(c.db.listDevices()[0]?.slimmedAt).toBeDefined();
	});

	test("an already-slimmed sim costs no launchctl spawn and is not restored", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], fakeSimctl([wardenSim(2, "Booted")], calls));
		c.db.recordDevice({ platform: "ios", id: "U2", name: "warden-iphone-17-2", profile: "iphone-17" }, 0);
		c.db.setSlimmed("ios", "U2", 5);
		expect(await claimCommand.run(c)).toBe(0);
		expect(slimSpawns(calls)).toBe(false);
		expect(c.db.listDevices()[0]?.slimmedAt).toBe(5);
	});

	test("--no-slim on a slimmed sim prints the restore hint and spawns nothing", async () => {
		const calls: string[][] = [];
		const c = setup(["ios", "--no-slim"], fakeSimctl([wardenSim(2, "Booted")], calls));
		c.db.recordDevice({ platform: "ios", id: "U2", name: "warden-iphone-17-2", profile: "iphone-17" }, 0);
		c.db.setSlimmed("ios", "U2", 5);
		expect(await claimCommand.run(c)).toBe(0);
		expect(slimSpawns(calls)).toBe(false);
		expect(c.stderr.join("\n")).toContain(
			"warden claim: warden-iphone-17-2 is slimmed; warden sim slim U2 --restore re-enables its daemons"
		);
	});

	test("--no-slim and WARDEN_SLIM=0 never slim a booted sim", async () => {
		for (const [argv, env] of [
			[["ios", "--no-slim"], {}],
			[["ios"], { WARDEN_SLIM: "0" }],
		] as const) {
			const calls: string[][] = [];
			const c = setup([...argv], fakeSimctl([wardenSim(2, "Booted")], calls));
			c.env = { ...c.env, ...env };
			c.db.recordDevice({ platform: "ios", id: "U2", name: "warden-iphone-17-2", profile: "iphone-17" }, 0);
			expect(await claimCommand.run(c)).toBe(0);
			expect(slimSpawns(calls)).toBe(false);
			expect(c.db.listDevices()[0]?.slimmedAt).toBeUndefined();
			c.cleanup();
		}
	});

	test("a sim the store has no record of is left alone", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], fakeSimctl([wardenSim(2, "Booted")], calls));
		expect(await claimCommand.run(c)).toBe(0);
		expect(calls.some((x) => x.includes("print-disabled"))).toBe(false);
	});
});

describe("warden claim auto-gc (16-1)", () => {
	test("auto-gc is considered only after the claim has leased its device", async () => {
		const order = autoGcOrder(fakeSimctl([wardenSim(2, "Booted")]), () => c.db);
		const c = setup(["ios"], order.exec);
		c.env = allowAutoGc(c.env);
		expect(await claimCommand.run(c)).toBe(0);
		expect(order.gcBeforeClaim()).toBe(false);
		expect(autoGcConsidered(c.db)).toBe(true);
	});
});

describe("warden claim --remote", () => {
	test("refuses --physical, before any lease or API call", async () => {
		const c = testContext(["android", "--remote", "--physical", "--json"]);
		try {
			expect(await claimCommand.run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain("can't be combined with --physical");
		} finally {
			c.cleanup();
		}
	});

	test("leases a hosted device; release stops it", async () => {
		const { fakeServer } = await import("../remote/api.testing");
		const { releaseCommand } = await import("./release");
		const server = fakeServer();
		const c = testContext(["ios", "--remote", "--json", "--profile", "iphone-17"], {
			fetch: server.fetch,
			sleep: async () => {},
		});
		try {
			c.env = { ...c.env, WARDEN_API_URL: "https://api.test", WARDEN_TOKEN: server.token, WARDEN_SESSION_ID: "s1" };
			expect(await claimCommand.run(c)).toBe(0);
			const out = JSON.parse(c.stdout.join("\n"));
			expect(out).toMatchObject({ remoteIds: ["rd1"], leases: [{ remote: true, remoteId: "rd1", name: "iphone-17" }] });
			expect(c.db.listLeases()[0]?.resource).toEqual({
				kind: "remote-device",
				platform: "ios",
				id: "rd1",
				name: "iphone-17",
			});

			c.stdout.length = 0;
			c.argv = [out.leases[0].leaseId, "--json"];
			expect(await releaseCommand.run(c)).toBe(0);
			expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({
				released: [out.leases[0].leaseId],
				remoteStopped: ["rd1"],
			});
			expect(server.devices.get("rd1")?.status).toBe("stopped");
		} finally {
			c.cleanup();
		}
	});

	test("--remote without a login fails with the hint", async () => {
		const c = testContext(["android", "--remote"]);
		try {
			expect(await claimCommand.run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain("warden login");
		} finally {
			c.cleanup();
		}
	});

	test("--view without --remote is a usage error and claims nothing", async () => {
		const c = setup(["ios", "--view"]);
		expect(await claimCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--view needs --remote");
		expect(c.db.listLeases()).toEqual([]);
	});

	test("--remote --view opens the viewer on the new lease and returns its exit code", async () => {
		const { fakeServer } = await import("../remote/api.testing");
		const { fakeViewer } = await import("../remote/viewer.testing");
		const server = fakeServer();
		const viewer = fakeViewer();
		viewer.exit(0);
		const c = testContext(["ios", "--remote", "--view", "--json", "--profile", "iphone-17"], {
			fetch: server.fetch,
			sleep: async () => {},
			spawn: viewer.spawn,
		});
		try {
			c.env = {
				...c.env,
				WARDEN_API_URL: "https://api.test",
				WARDEN_TOKEN: server.token,
				WARDEN_SESSION_ID: "s1",
				WARDEN_VIEWER_PATH: "/dev/warden-viewer",
			};
			expect(await claimCommand.run(c)).toBe(0);
			expect(viewer.spawns[0]?.cmd).toEqual(["/dev/warden-viewer"]);
			expect(viewer.stdin[0]).toMatchObject({ deviceId: "rd1", scope: "drive", title: "iphone-17 · warden" });
			expect(server.viewerTokens[0]?.ttlS).toBeUndefined();
			expect(() => JSON.parse(c.stdout.join("\n"))).not.toThrow();
		} finally {
			c.cleanup();
		}
	});
});

describe("warden claim --physical", () => {
	test("with no phone present it fails without booting or creating anything", async () => {
		const calls: string[][] = [];
		const c = setup(
			["ios", "--physical", "--no-wait", "--json"],
			fakeSimctl([wardenSim(1), wardenSim(2, "Booted")], calls)
		);
		expect(await claimCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("no free ready physical ios device");
		expect(calls.filter((x) => ["boot", "create", "shutdown", "clone"].includes(x[2] ?? ""))).toEqual([]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("incompatible flags exit 1 before touching a device", async () => {
		const calls: string[][] = [];
		const c = setup(["android", "--physical", "--count", "2"], fakeSimctl([], calls));
		expect(await claimCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--count cannot be used with --physical");
		expect(calls).toEqual([]);
	});

	test("--serial names android devices: on ios it is refused, on android it asks for those ids", async () => {
		const wrong = setup(["ios", "--serial", "R5CT"], fakeSimctl([]));
		expect(await claimCommand.run(wrong)).toBe(1);
		expect(wrong.stderr.join("\n")).toContain("--serial is android-only");
	});

	test("WARDEN_HEADLESS in the environment does not reject --physical", async () => {
		const c = setup(["ios", "--physical", "--no-wait"], fakeSimctl([]));
		c.env = { ...c.env, WARDEN_HEADLESS: "1" };
		expect(await claimCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).not.toContain("cannot be used");
	});
});

describe("warden claim --physical with several phones", () => {
	const USB = "R5CT1234ABC";
	const WIFI = "192.168.1.20:5555";
	const ADB_TWO = `List of devices attached
${USB}            device usb:1-1 product:a54xnaeea model:SM_A546E device:a54x transport_id:2
${WIFI}      device product:husky model:Pixel_8_Pro device:husky transport_id:5

`;

	function twoPhones(argv: string[], ui: ScriptedUi = scriptedUi(), calls: string[][] = []): TestContext {
		ctx = testContext(argv, {
			ui,
			exec: fakeExec(
				[
					["adb devices -l", { stdout: ADB_TWO }],
					[`adb -s ${USB} shell ${PHONE_PROBE_SCRIPT}`, { stdout: PHONE_PROPS }],
					[`adb -s ${WIFI} shell ${PHONE_PROBE_SCRIPT}`, { stdout: "\n\nHW2\nPixel 8 Pro\n35\n" }],
					["adb -s", { stdout: "1\n" }],
				],
				calls
			),
		});
		ctx.env = { ...ctx.env, ...OWNER_ENV };
		return ctx;
	}

	test("--json: ambiguous_device, exit 2, candidates in the error, no lease", async () => {
		const c = twoPhones(["android", "--physical", "--no-wait", "--json"], scriptedUi({ interactive: true }));
		expect(await claimCommand.run(c)).toBe(2);
		const doc = JSON.parse(c.stdout.join("\n"));
		expect(doc).toMatchObject({
			ok: false,
			command: "claim",
			error: {
				code: "ambiguous_device",
				hint: "pass --udid <id> (iOS) / --serial <id> (Android), or set WARDEN_PHYSICAL_IDS",
			},
		});
		expect(doc.error.details.candidates).toEqual([
			{ id: USB, name: "SM-A546E", platform: "android", model: "SM-A546E", osVersion: "API 34", transport: "usb" },
			{
				id: WIFI,
				name: "Pixel 8 Pro",
				platform: "android",
				model: "Pixel 8 Pro",
				osVersion: "API 35",
				transport: "wifi",
			},
		]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("not a terminal: plain text lists the candidates as a table, exit 2", async () => {
		const c = twoPhones(["android", "--physical", "--no-wait"]);
		expect(await claimCommand.run(c)).toBe(2);
		const err = c.stderr.join("\n");
		expect(err).toContain("several physical android devices are available");
		expect(err).toMatch(/ID\s+NAME\s+MODEL\s+OS\s+TRANSPORT/);
		expect(err).toContain(WIFI);
		expect(err).toContain("WARDEN_PHYSICAL_IDS");
		expect(c.db.listLeases()).toEqual([]);
	});

	test("a terminal: the picker's second choice is the one claimed", async () => {
		const ui = scriptedUi({ interactive: true, select: [WIFI] });
		const c = twoPhones(["android", "--physical", "--no-wait"], ui);
		expect(await claimCommand.run(c)).toBe(0);
		const resource = c.db.listLeases()[0]?.resource;
		expect(resource?.kind === "device" && resource.id).toBe(WIFI);
	});

	test("cancelling the picker exits 1 with Aborted. and takes nothing", async () => {
		const ui = scriptedUi({ interactive: true, select: [undefined] });
		const c = twoPhones(["android", "--physical", "--no-wait"], ui);
		expect(await claimCommand.run(c)).toBe(1);
		expect(ui.events).toContain("cancelled: Aborted.");
		expect(c.db.listLeases()).toEqual([]);
	});

	test("--serial names one: no question even with two phones", async () => {
		const ui = scriptedUi({ interactive: true });
		const c = twoPhones(["android", "--serial", USB, "--no-wait"], ui);
		expect(await claimCommand.run(c)).toBe(0);
		expect(ui.events.filter((e) => e.startsWith("select:"))).toEqual([]);
	});

	test("WARDEN_PHYSICAL_IDS narrowing to one claims it without asking", async () => {
		const ui = scriptedUi({ interactive: true });
		const c = twoPhones(["android", "--physical", "--no-wait"], ui);
		c.env = { ...c.env, WARDEN_PHYSICAL_IDS: WIFI };
		expect(await claimCommand.run(c)).toBe(0);
		const resource = c.db.listLeases()[0]?.resource;
		expect(resource?.kind === "device" && resource.id).toBe(WIFI);
		expect(ui.events.filter((e) => e.startsWith("select:"))).toEqual([]);
	});
});

describe("warden claim of a locked iPhone", () => {
	const LIST = devicectlJson([
		devicectlEntry({
			udid: FAKE_IPHONE_UDID,
			name: "Test iPhone",
			deviceType: "iPhone",
			osVersion: "27.2",
			transportType: "wired",
		}),
	]);
	const locked = (argv: string[]): TestContext =>
		setup(
			argv,
			fakeSimctl(
				[],
				[],
				[
					["xcrun devicectl list devices", { stdout: LIST }],
					["xcrun devicectl device info lockState", { stdout: DEVICECTL_LOCKSTATE_LOCKED }],
				]
			)
		);

	test("--no-wait --json: device_locked, exit 2, the hint, no lease", async () => {
		const c = locked(["ios", "--udid", FAKE_IPHONE_UDID, "--no-wait", "--json"]);
		expect(await claimCommand.run(c)).toBe(2);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({
			ok: false,
			command: "claim",
			error: { code: "device_locked", message: "Test iPhone is locked", hint: "unlock the phone, then retry" },
		});
		expect(c.db.listLeases()).toEqual([]);
	});

	test("--no-wait in text mode: exit 2 and the hint on stderr", async () => {
		const c = locked(["ios", "--udid", FAKE_IPHONE_UDID, "--no-wait"]);
		expect(await claimCommand.run(c)).toBe(2);
		expect(c.stderr.join("\n")).toContain("Test iPhone is locked");
		expect(c.stderr.join("\n")).toContain("unlock the phone, then retry");
		expect(c.stdout).toEqual([]);
	});
});
