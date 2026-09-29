import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@warden/core/types";
import { fakeSimctl, OWNER_ENV } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { releaseCommand } from "./release";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const me: Owner = { kind: "agent", sessionId: "me", cwd: "/" };
const other: Owner = { kind: "agent", sessionId: "other", cwd: "/" };

function setup(argv: string[], calls: string[][] = []): TestContext {
	ctx = testContext(argv, { exec: fakeSimctl([], calls) });
	ctx.env = { ...ctx.env, ...OWNER_ENV };
	return ctx;
}

function lease(c: TestContext, id: string, owner: Owner = me) {
	return c.db.insertLease(
		{ resource: { kind: "device", platform: "ios", id, name: `warden-iphone-17-${id}` }, owner, ttlMs: 60_000 },
		c.now()
	);
}

describe("warden release", () => {
	test("by lease id", async () => {
		const c = setup([]);
		const a = lease(c, "U1");
		const b = lease(c, "U2");
		c.argv = [a.id, "--json"];
		expect(await releaseCommand.run(c)).toBe(0);
		expect(c.db.listLeases().map((l) => l.id)).toEqual([b.id]);
		expect(JSON.parse(c.stdout.join("\n")).released).toEqual([a.id]);
	});

	test("--udid, --mine, --session", async () => {
		const c = setup([]);
		lease(c, "U1");
		lease(c, "U2");
		lease(c, "U3", other);
		c.argv = ["--udid", "U1"];
		expect(await releaseCommand.run(c)).toBe(0);
		expect(c.db.listLeases()).toHaveLength(2);
		c.argv = ["--mine"];
		expect(await releaseCommand.run(c)).toBe(0);
		expect(c.db.listLeases().map((l) => l.resource)).toMatchObject([{ id: "U3" }]);
		c.argv = ["--session", "other"];
		expect(await releaseCommand.run(c)).toBe(0);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("--shutdown only shuts down warden-created devices", async () => {
		const calls: string[][] = [];
		const c = setup([], calls);
		c.db.recordDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1", profile: "iphone-17" }, 0);
		lease(c, "U1");
		lease(c, "FOREIGN");
		c.argv = ["--mine", "--shutdown", "--json"];
		expect(await releaseCommand.run(c)).toBe(0);
		const shutdowns = calls.filter((x) => x[2] === "shutdown").map((x) => x[3]);
		expect(shutdowns).toEqual(["U1"]);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.shutdown).toEqual(["U1"]);
		expect(out.notes.join(" ")).toContain("FOREIGN");
		expect(c.db.listDevices("ios")[0]?.lastUsedAt).toBe(c.now());
	});

	test("no selector / unknown id → exit 1", async () => {
		const c = setup([]);
		expect(await releaseCommand.run(c)).toBe(1);
		c.argv = ["l_nope"];
		expect(await releaseCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("l_nope");
	});
});
