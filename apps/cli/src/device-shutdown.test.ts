import { afterEach, describe, expect, test } from "bun:test";
import { activeConditions, recordCondition } from "@delacour/warden-core/conditions/conditions";
import type { Exec } from "@delacour/warden-core/exec";
import type { Lease, Owner } from "@delacour/warden-core/types";
import { shutdownReleasedDevices } from "./device-shutdown";
import { fakeSimctl } from "./simctl.testing";
import { type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const owner: Owner = { kind: "agent", sessionId: "s", cwd: "/" };

function lease(c: TestContext, id: string, bootedByOwner = false): Lease {
	return c.db.insertLease(
		{ resource: { kind: "device", platform: "ios", id, name: id }, owner, ttlMs: 60_000, bootedByOwner },
		c.now()
	);
}

function physicalLease(c: TestContext, id: string): Lease {
	return c.db.insertLease(
		{
			resource: { kind: "device", platform: "android", id, name: "Pixel", physical: { transport: "usb" } },
			owner,
			ttlMs: 60_000,
			bootedByOwner: true,
		},
		c.now()
	);
}

describe("shutdownReleasedDevices", () => {
	test("a physical device is never shut down, even booted by the owner and recorded; no provider call is made", async () => {
		const calls: string[][] = [];
		ctx = testContext([], { exec: fakeSimctl([], calls) });
		ctx.db.recordDevice({ platform: "android", id: "P1", name: "Pixel" }, 0);
		const guarded: string[] = [];
		const result = await shutdownReleasedDevices(ctx, [physicalLease(ctx, "P1")], owner, async (l) => {
			guarded.push(l.id);
			return undefined;
		});
		expect(result.shutdown).toEqual([]);
		expect(result.kept).toEqual([]);
		expect(result.notes.join("\n")).toContain("physical device: never shut down");
		expect(calls).toEqual([]);
		expect(guarded).toEqual([]);
	});

	test("undoes the lease's conditions before shutting its device down", async () => {
		const calls: string[][] = [];
		ctx = testContext([], { exec: fakeSimctl([], calls, [["xcrun simctl location", {}]]) });
		ctx.db.recordDevice({ platform: "ios", id: "W", name: "warden-iphone-17-1" }, 0);
		const w = lease(ctx, "W");
		recordCondition(ctx.db, w.id, "location", { kind: "point", lat: 1, lon: 2 }, 1);
		const result = await shutdownReleasedDevices(ctx, [w], owner);
		const verbs = calls.map((c) => c[2]);
		expect(verbs.indexOf("location")).toBeGreaterThanOrEqual(0);
		expect(verbs.indexOf("location")).toBeLessThan(verbs.indexOf("shutdown"));
		expect(result.shutdown).toEqual(["W"]);
		expect(activeConditions(ctx.db, w.id)).toEqual([]);
	});

	test("a foreign device keeps its conditions untouched (never reset what warden doesn't shut down)", async () => {
		const calls: string[][] = [];
		ctx = testContext([], { exec: fakeSimctl([], calls) });
		const f = lease(ctx, "USERS");
		recordCondition(ctx.db, f.id, "location", { kind: "clear" }, 1);
		await shutdownReleasedDevices(ctx, [f], owner);
		expect(calls.filter((c) => c[2] === "location")).toEqual([]);
	});

	test("shuts down warden-created + owner-booted devices; leaves already-running foreign ones", async () => {
		const calls: string[][] = [];
		ctx = testContext([], { exec: fakeSimctl([], calls) });
		ctx.env = { ...ctx.env, WARDEN_GOLDEN: "0" };
		ctx.db.recordDevice({ platform: "ios", id: "W", name: "warden-iphone-17-1" }, 0);
		const leases = [lease(ctx, "W"), lease(ctx, "BOOTED-BY-ME", true), lease(ctx, "USERS")];
		const result = await shutdownReleasedDevices(ctx, leases, owner);
		expect(result.shutdown).toEqual(["W", "BOOTED-BY-ME"]);
		expect(result.notes.join("\n")).toContain("USERS");
		expect(calls.filter((c) => c[2] === "shutdown").map((c) => c[3])).toEqual(["W", "BOOTED-BY-ME"]);
	});

	test("closes the viewer windows of the iOS sims it shut down, once, by name (Device Hub keeps a page open)", async () => {
		const calls: string[][] = [];
		ctx = testContext([], {
			exec: fakeSimctl([], calls, [
				["pgrep -xq Simulator", { exitCode: 1 }],
				["pgrep -xq DeviceHub", { exitCode: 0 }],
				["osascript", {}],
			]),
		});
		ctx.db.recordDevice({ platform: "ios", id: "W", name: "W" }, 0);
		const result = await shutdownReleasedDevices(
			ctx,
			[lease(ctx, "W"), lease(ctx, "B", true), lease(ctx, "USERS")],
			owner
		);
		expect(result.shutdown).toEqual(["W", "B"]);
		const closes = calls.filter((c) => c[0] === "osascript" && (c[4] ?? "").includes("AXCloseButton"));
		expect(closes).toHaveLength(1);
		expect(JSON.parse(closes[0]?.[5] ?? "")).toEqual(["W", "B"]);
		expect(calls.indexOf(closes[0] as string[])).toBeGreaterThan(calls.map((c) => c[2]).lastIndexOf("shutdown"));
	});

	test("a window that won't close is a note; the shutdown still counts", async () => {
		ctx = testContext([], {
			exec: fakeSimctl(
				[],
				[],
				[
					["pgrep -xq Simulator", { exitCode: 1 }],
					["pgrep -xq DeviceHub", { exitCode: 0 }],
					["osascript", { exitCode: 1, stderr: "kaput" }],
				]
			),
		});
		const result = await shutdownReleasedDevices(ctx, [lease(ctx, "A", true)], owner);
		expect(result.shutdown).toEqual(["A"]);
		expect(result.notes.join("\n")).toContain("couldn't close");
	});

	test("shuts devices down concurrently, reporting in lease order", async () => {
		const started: string[] = [];
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const exec: Exec = async (cmd) => {
			if (cmd[2] !== "shutdown") return { exitCode: 127, stdout: "", stderr: "" };
			started.push(cmd[3] ?? "");
			await gate;
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		ctx = testContext([], { exec });
		const running = shutdownReleasedDevices(ctx, [lease(ctx, "A", true), lease(ctx, "B", true)], owner);
		await Bun.sleep(0);
		expect(started.sort()).toEqual(["A", "B"]);
		release();
		expect((await running).shutdown).toEqual(["A", "B"]);
	});

	test("a throwing guard is a note and doesn't stop the other shutdowns", async () => {
		ctx = testContext([], { exec: fakeSimctl([]) });
		const result = await shutdownReleasedDevices(
			ctx,
			[lease(ctx, "A", true), lease(ctx, "B", true)],
			owner,
			async (l) => {
				if (l.resource.kind === "device" && l.resource.id === "A") throw new Error("kaput");
				return undefined;
			}
		);
		expect(result.shutdown).toEqual(["B"]);
		expect(result.notes.join("\n")).toContain("kaput");
	});

	test("shutdown failure is a note, not a throw", async () => {
		ctx = testContext([], { exec: fakeSimctl([], [], [["xcrun simctl shutdown", { exitCode: 1, stderr: "boom" }]]) });
		const result = await shutdownReleasedDevices(ctx, [lease(ctx, "X", true)], owner);
		expect(result.shutdown).toEqual([]);
		expect(result.notes.join("\n")).toContain("boom");
	});
});
