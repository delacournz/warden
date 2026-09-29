import { afterEach, describe, expect, test } from "bun:test";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
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
});
