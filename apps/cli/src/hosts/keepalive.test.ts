import { afterEach, describe, expect, test } from "bun:test";
import type { ExecResult } from "@delacour/warden-core/exec";
import { type HostRecord, putHost } from "@delacour/warden-core/hosts/registry";
import type { Owner } from "@delacour/warden-core/types";
import { type TestContext, testContext } from "../testing";
import { claimOnHost, hostLeases } from "./claim";
import { KEEPALIVE_META, keepaliveTick, shouldStartKeepalive } from "./keepalive";

const ctxs: TestContext[] = [];
afterEach(() => {
	for (const ctx of ctxs.splice(0)) ctx.cleanup();
});

type World = { now: number; down: boolean; unknown: string[]; remotes: string[][] };

const HOST: HostRecord = { name: "mac", ssh: { hostname: "mac.tail" }, addedAt: 1 };
const OWNER: Owner = { kind: "agent", sessionId: "s1", cwd: "/repo" };
const CLAIMED = JSON.stringify({
	leases: [{ leaseId: "R1", platform: "ios", udid: "U1", name: "warden-iphone-1", action: "reuse" }],
});

async function setup(host: HostRecord = HOST): Promise<{ ctx: TestContext; world: World }> {
	const world: World = { now: 1_000_000, down: false, unknown: [], remotes: [] };
	const ctx = testContext([], {
		now: () => world.now,
		exec: async (cmd: readonly string[]): Promise<ExecResult> => {
			const remote = cmd.slice(cmd.indexOf("--") + 2);
			world.remotes.push(remote);
			if (world.down) return { exitCode: 255, stdout: "", stderr: "ssh: connect to host mac.tail: Connection refused" };
			if (remote[0] === "claim") return { exitCode: 0, stdout: CLAIMED, stderr: "" };
			if (remote[0] === "heartbeat") {
				return { exitCode: 0, stdout: JSON.stringify({ heartbeat: [], unknown: world.unknown }), stderr: "" };
			}
			return { exitCode: 0, stdout: '{"released":["R1"]}', stderr: "" };
		},
	});
	ctxs.push(ctx);
	putHost(ctx.db, host);
	const r = await claimOnHost(ctx, { host: "mac", platform: "ios", owner: OWNER, ttlMs: 30 * 60_000, remoteArgs: [] });
	if (!r.success) throw new Error(r.error);
	return { ctx, world };
}

const lost = (ctx: TestContext) =>
	ctx.db
		.listEvents()
		.filter((e) => e.type === "host_lost")
		.map((e) => (e.type === "host_lost" ? e.data.reason : ""));

describe("keepaliveTick", () => {
	test("renews the host lease while the local one lives", async () => {
		const { ctx, world } = await setup();
		expect(await keepaliveTick(ctx, "mac", 0)).toEqual({ done: false, failures: 0 });
		expect(world.remotes.at(-1)).toEqual(["heartbeat", "R1", "--json"]);
	});

	test("no host leases left: done", async () => {
		const { ctx } = await setup();
		ctx.db.deleteLeases(ctx.db.listLeases().map((l) => l.id));
		expect(await keepaliveTick(ctx, "mac", 0)).toEqual({ done: true, failures: 0 });
	});

	test("a local lease that went stale is released on the host and dropped here", async () => {
		const { ctx, world } = await setup();
		world.now += 31 * 60_000;
		expect((await keepaliveTick(ctx, "mac", 0)).done).toBe(true);
		expect(world.remotes.at(-1)).toEqual(["release", "R1", "--json"]);
		expect(hostLeases(ctx.db.listLeases())).toHaveLength(0);
	});

	test("three unreachable beats in a row lose the lease (unreachable); one success resets the count", async () => {
		const { ctx, world } = await setup();
		world.down = true;
		expect(await keepaliveTick(ctx, "mac", 0)).toEqual({ done: false, failures: 1 });
		world.down = false;
		expect(await keepaliveTick(ctx, "mac", 1)).toEqual({ done: false, failures: 0 });
		world.down = true;
		let failures = 0;
		for (let i = 0; i < 3; i++) failures = (await keepaliveTick(ctx, "mac", failures)).failures;
		expect(hostLeases(ctx.db.listLeases())).toHaveLength(0);
		expect(lost(ctx)).toEqual(["unreachable"]);
	});

	test("a lease the host no longer holds is lost (remote_gone)", async () => {
		const { ctx, world } = await setup();
		world.unknown = ["R1"];
		expect((await keepaliveTick(ctx, "mac", 0)).done).toBe(true);
		expect(lost(ctx)).toEqual(["remote_gone"]);
	});

	test("a hosted Mac's session end loses the lease (host_expired) and releases it there", async () => {
		const { ctx, world } = await setup({ ...HOST, expiresAt: 1_000_000 + 60_000 });
		world.now += 60_000;
		expect((await keepaliveTick(ctx, "mac", 0)).done).toBe(true);
		expect(lost(ctx)).toEqual(["host_expired"]);
		expect(world.remotes.at(-1)?.[0]).toBe("release");
	});
});

describe("shouldStartKeepalive", () => {
	test("only when no live keepalive holds the host's row, and background work is allowed", async () => {
		const { ctx } = await setup();
		const env = { ...ctx.env, WARDEN_BACKGROUND: "1" };
		expect(shouldStartKeepalive(ctx.db, env, "mac", () => true)).toBe(true);
		ctx.db.setMeta(`${KEEPALIVE_META}mac`, "4242");
		expect(shouldStartKeepalive(ctx.db, env, "mac", () => true)).toBe(false);
		expect(shouldStartKeepalive(ctx.db, env, "mac", () => false)).toBe(true);
		expect(shouldStartKeepalive(ctx.db, ctx.env, "mac", () => false)).toBe(false);
	});
});
