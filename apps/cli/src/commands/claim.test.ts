import { afterEach, describe, expect, test } from "bun:test";
import { simctlDevicesJson } from "@delacour/warden-core/providers/ios.fixture";
import { allowAutoGc, autoGcConsidered, autoGcOrder } from "../autogc.testing";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { type ScriptedUi, scriptedUi, type TestContext, testContext } from "../testing";
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

	test("a full host queues: the progress line is on stderr and --json stdout stays empty on failure", async () => {
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
		expect(c.stdout).toEqual([]);
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

	test("a device left slimmed is restored on a plain claim, and the record cleared", async () => {
		const calls: string[][] = [];
		const exec = fakeSimctl([wardenSim(2, "Booted")], calls, [
			["xcrun simctl spawn U2 launchctl print-disabled", { stdout: '\t"com.apple.healthd" => disabled\n' }],
		]);
		const c = setup(["ios"], exec);
		c.db.recordDevice({ platform: "ios", id: "U2", name: "warden-iphone-17-2", profile: "iphone-17" }, 0);
		c.db.setSlimmed("ios", "U2", 5);
		expect(await claimCommand.run(c)).toBe(0);
		expect(calls.map((x) => x.join(" "))).toContain("xcrun simctl spawn U2 launchctl enable system/com.apple.healthd");
		expect(c.db.listDevices()[0]?.slimmedAt).toBeUndefined();
		expect(c.stderr.join("\n")).toContain("re-enabled 1 slimmed job(s)");
	});

	test("a device that was never slimmed costs no print-disabled spawn", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], fakeSimctl([wardenSim(2, "Booted")], calls));
		c.db.recordDevice({ platform: "ios", id: "U2", name: "warden-iphone-17-2", profile: "iphone-17" }, 0);
		expect(await claimCommand.run(c)).toBe(0);
		expect(calls.some((x) => x.includes("print-disabled"))).toBe(false);
		expect(c.stderr.join("\n")).not.toContain("slimmed");
	});

	test("a sim the store has no record of is left alone too", async () => {
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
