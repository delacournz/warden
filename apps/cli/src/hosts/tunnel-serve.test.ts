import { afterEach, describe, expect, test } from "bun:test";
import { HOST_OWNER_ENV } from "@delacour/warden-core/hosts/registry";
import { claimPorts } from "@delacour/warden-core/ports";
import type { Owner } from "@delacour/warden-core/types";
import { type TestContext, testContext } from "../testing";
import { serveTunnel } from "./tunnel-serve";

const ctxs: TestContext[] = [];
afterEach(() => {
	for (const ctx of ctxs.splice(0)) ctx.cleanup();
});

const HOST_OWNER: Owner = { kind: "host", machineId: "m1", user: "me" };

async function hostContext(): Promise<{ ctx: TestContext; leaseId: string; port: number }> {
	const ctx = testContext([]);
	ctx.env[HOST_OWNER_ENV] = JSON.stringify({ machineId: "m1", user: "me" });
	ctxs.push(ctx);
	const r = await claimPorts(
		ctx.db,
		{ owner: HOST_OWNER, from: 8091, span: 10, count: 1, ttlMs: 90_000 },
		{ now: ctx.now, pidAlive: () => true, isPortFree: async () => true }
	);
	if (!r.success) throw new Error(r.error);
	const lease = r.data[0];
	if (lease === undefined || lease.resource.kind !== "port") throw new Error("no port");
	return { ctx, leaseId: lease.id, port: lease.resource.port };
}

/** A stdin that closes when `close()` is called. */
function closer(): { closed: Promise<void>; close: () => void } {
	let close = () => {};
	const closed = new Promise<void>((resolve) => {
		close = resolve;
	});
	return { closed, close };
}

describe("serveTunnel", () => {
	test("waits for Metro through the forward, says ready, beats the port lease until stdin closes, then releases it", async () => {
		const { ctx, leaseId, port } = await hostContext();
		const stdin = closer();
		let probes = 0;
		let beats = 0;
		const done = serveTunnel(
			ctx,
			{ port, leaseId },
			{
				probe: async () => ++probes >= 2,
				closed: stdin.closed,
				sleep: async () => {
					beats++;
					if (beats === 3) stdin.close();
					await Bun.sleep(0);
				},
				beatMs: 1,
				readyTimeoutMs: 60_000,
			}
		);
		expect(await done).toBe(0);
		expect(JSON.parse(ctx.stdout[0] ?? "")).toEqual({ ready: true, port });
		expect(probes).toBe(2);
		expect(ctx.db.getLease(leaseId)).toBeUndefined();
	});

	test("Metro never answers through the forward: not ready, exit 1, lease released", async () => {
		const { ctx, leaseId, port } = await hostContext();
		let now = 1_000_000;
		ctx.now = () => now;
		const code = await serveTunnel(
			ctx,
			{ port, leaseId },
			{
				probe: async () => false,
				closed: new Promise(() => {}),
				sleep: async (ms) => {
					now += ms;
				},
				readyTimeoutMs: 5_000,
			}
		);
		expect(code).toBe(1);
		expect(JSON.parse(ctx.stdout[0] ?? "").error.message).toContain(`no Metro on 127.0.0.1:${port}`);
		expect(ctx.db.getLease(leaseId)).toBeUndefined();
	});

	test("a lease that is not this caller's port lease on that port is refused and left alone", async () => {
		const { ctx, leaseId, port } = await hostContext();
		ctx.env[HOST_OWNER_ENV] = JSON.stringify({ machineId: "other", user: "me" });
		const deps = { probe: async () => true, closed: Promise.resolve(), sleep: async () => {} };
		expect(await serveTunnel(ctx, { port, leaseId }, deps)).toBe(1);
		expect(ctx.stdout[0]).toContain("not your port lease");
		ctx.env[HOST_OWNER_ENV] = JSON.stringify({ machineId: "m1", user: "me" });
		expect(await serveTunnel(ctx, { port: port + 1, leaseId }, deps)).toBe(1);
		expect(await serveTunnel(ctx, { port, leaseId: "nope" }, deps)).toBe(1);
		expect(ctx.db.getLease(leaseId)).toBeDefined();
	});
});
