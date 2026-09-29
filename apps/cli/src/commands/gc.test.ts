import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@warden/core/types";
import { fakeSimctl } from "../simctl.testing";
import { fakeExec, type TestContext, testContext } from "../testing";
import { gcCommand } from "./gc";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const NOW = 100 * 60_000;
const agent: Owner = { kind: "agent", sessionId: "a", cwd: "/" };

function setup(argv: string[], calls: string[][]): TestContext {
	ctx = testContext(argv, {
		now: () => NOW,
		exec: fakeSimctl(
			[
				{ udid: "U1", name: "warden-iphone-17-1", state: "Booted" },
				{ udid: "U2", name: "warden-iphone-17-2", state: "Booted" },
				{ udid: "U3", name: "warden-iphone-17-3", state: "Booted" },
				{ udid: "U4", name: "warden-iphone-17-4", state: "Shutdown" },
				{ udid: "F", name: "iPhone 17", state: "Booted" },
			],
			calls
		),
	});
	const db = ctx.db;
	db.recordDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1" }, 0);
	db.recordDevice({ platform: "ios", id: "U2", name: "warden-iphone-17-2" }, 0);
	db.recordDevice({ platform: "ios", id: "U3", name: "warden-iphone-17-3" }, NOW - 60_000);
	db.recordDevice({ platform: "ios", id: "U4", name: "warden-iphone-17-4" }, 0);
	db.insertLease(
		{
			resource: { kind: "device", platform: "ios", id: "U2", name: "warden-iphone-17-2" },
			owner: agent,
			ttlMs: 60_000,
		},
		NOW
	);
	db.insertLease({ resource: { kind: "port", port: 9 }, owner: agent, ttlMs: 1 }, 0);
	return ctx;
}

describe("warden gc", () => {
	test("reclaims stale leases, shuts down idle unleased warden devices only", async () => {
		const calls: string[][] = [];
		const c = setup(["--json"], calls);
		expect(await gcCommand.run(c)).toBe(0);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.reclaimed).toHaveLength(1);
		expect(out.shutdown).toEqual([{ platform: "ios", id: "U1", name: "warden-iphone-17-1" }]);
		const shutdowns = calls.filter((x) => x[1] === "simctl" && x[2] === "shutdown").map((x) => x[3]);
		expect(shutdowns).toEqual(["U1"]);
		expect(calls.some((x) => x.includes("delete") || x.includes("erase"))).toBe(false);
		expect(c.db.listLeases().map((l) => l.resource)).toMatchObject([{ id: "U2" }]);
	});

	test("--idle shortens the idle window", async () => {
		const calls: string[][] = [];
		const c = setup(["--idle", "30s"], calls);
		expect(await gcCommand.run(c)).toBe(0);
		const shutdowns = calls.filter((x) => x[1] === "simctl" && x[2] === "shutdown").map((x) => x[3]);
		expect(shutdowns.sort()).toEqual(["U1", "U3"]);
	});

	test("bad --idle → exit 1", async () => {
		const c = setup(["--idle", "soon"], []);
		expect(await gcCommand.run(c)).toBe(1);
	});

	test("forgets android records whose emulator is gone (unleased); keeps leased ones", async () => {
		ctx = testContext(["--json"], {
			now: () => NOW,
			exec: fakeExec([["adb devices -l", { stdout: "List of devices attached\n\n" }]]),
		});
		ctx.db.recordDevice({ platform: "android", id: "emulator-5554", name: "warden-pixel-10-1" }, 0);
		ctx.db.recordDevice({ platform: "android", id: "emulator-5556", name: "warden-pixel-10-2" }, 0);
		ctx.db.insertLease(
			{
				resource: { kind: "device", platform: "android", id: "emulator-5556", name: "warden-pixel-10-2" },
				owner: agent,
				ttlMs: 60_000,
			},
			NOW
		);
		expect(await gcCommand.run(ctx)).toBe(0);
		expect(ctx.db.listDevices("android").map((d) => d.id)).toEqual(["emulator-5556"]);
		expect(JSON.parse(ctx.stdout.join("\n")).forgotten).toEqual([
			{ platform: "android", id: "emulator-5554", name: "warden-pixel-10-1" },
		]);
	});

	test("stale lease of a crashed session → device shut down if that session booted it; foreign running one left alone", async () => {
		const calls: string[][] = [];
		const c = setup(["--json"], calls);
		c.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "F", name: "iPhone 17" },
				owner: agent,
				ttlMs: 1,
				bootedByOwner: true,
			},
			0
		);
		expect(await gcCommand.run(c)).toBe(0);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.shutdown.map((d: { id: string }) => d.id)).toContain("F");
		expect(calls.filter((x) => x[2] === "shutdown").map((x) => x[3])).toContain("F");
	});

	test("--quiet prints nothing; last run recorded", async () => {
		const c = setup(["--quiet"], []);
		expect(await gcCommand.run(c)).toBe(0);
		expect(c.stdout).toEqual([]);
		expect(c.db.getMeta("last_gc_at")).toBe(String(NOW));
	});
});
