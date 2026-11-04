import { afterEach, describe, expect, test } from "bun:test";
import type { Lease } from "@delacour/warden-core/types";
import { type TestContext, testContext } from "../testing";
import { ensureOnHost, hostLeaseFor } from "./app";

const ctxs: TestContext[] = [];
afterEach(() => {
	for (const c of ctxs.splice(0)) c.cleanup();
});

function setup(): { ctx: TestContext; lease: Lease } {
	const ctx = testContext([]);
	ctxs.push(ctx);
	ctx.env.WARDEN_SESSION_ID = "me";
	const lease = ctx.db.insertLease(
		{
			resource: { kind: "host-device", host: "mac", remoteLeaseId: "R1", platform: "ios", id: "U1", name: "iphone" },
			owner: { kind: "agent", sessionId: "me", cwd: ctx.cwd },
			ttlMs: 60_000,
		},
		ctx.now()
	);
	return { ctx, lease };
}

describe("hostLeaseFor", () => {
	test("--lease or --udid naming one of the caller's host leases; anything else is not a host target", () => {
		const { ctx, lease } = setup();
		const owner = { kind: "agent", sessionId: "me", cwd: ctx.cwd } as const;
		expect(hostLeaseFor(ctx, owner, { lease: lease.id })?.id).toBe(lease.id);
		expect(hostLeaseFor(ctx, owner, { udid: "U1" })?.id).toBe(lease.id);
		expect(hostLeaseFor(ctx, owner, { udid: "OTHER" })).toBeUndefined();
		expect(hostLeaseFor(ctx, { kind: "agent", sessionId: "x", cwd: "/" }, { udid: "U1" })).toBeUndefined();
	});
});

describe("ensureOnHost", () => {
	test("resolves the build here (no install), then installs it on the host's device", async () => {
		const { ctx, lease } = setup();
		const hl = hostLeaseFor(ctx, { kind: "agent", sessionId: "me", cwd: ctx.cwd }, { lease: lease.id });
		if (!hl) throw new Error("no lease");
		const r = await ensureOnHost(ctx, hl, {
			resolve: async () => ({
				success: true,
				data: { appPath: "/c/Example.app", hash: "h1", source: "cache", installed: false },
			}),
			install: async (_c, l, path) => {
				expect([l.resource.host, path]).toEqual(["mac", "/c/Example.app"]);
				return { success: true, data: "/h/uploads/x/Example.app" };
			},
		});
		expect(r).toEqual({
			success: true,
			data: {
				appPath: "/c/Example.app",
				hash: "h1",
				source: "cache",
				installed: true,
				host: "mac",
				hostPath: "/h/uploads/x/Example.app",
			},
		});
	});

	test("a cache with no build for it (appPath empty) is an error, not an install of nothing", async () => {
		const { ctx, lease } = setup();
		const hl = hostLeaseFor(ctx, { kind: "agent", sessionId: "me", cwd: ctx.cwd }, { lease: lease.id });
		if (!hl) throw new Error("no lease");
		const r = await ensureOnHost(ctx, hl, {
			resolve: async () => ({ success: true, data: { appPath: "", hash: "h1", source: "cache", installed: false } }),
			install: async () => ({ success: true, data: "x" }),
		});
		expect(r.success).toBe(false);
	});
});
