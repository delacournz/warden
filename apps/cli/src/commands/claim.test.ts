import { afterEach, describe, expect, test } from "bun:test";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { scriptedUi, type TestContext, testContext } from "../testing";
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
		expect(calls.map((x) => x.join(" "))).toContain("xcrun simctl boot U1");
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
		const c = setup(["ios", "--max", "1"], fakeSimctl([wardenSim(1, "Booted")]));
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
});
