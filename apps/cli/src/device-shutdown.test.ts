import { afterEach, describe, expect, test } from "bun:test";
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

describe("shutdownReleasedDevices", () => {
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
