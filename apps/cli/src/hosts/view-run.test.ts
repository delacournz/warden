import { afterEach, describe, expect, test } from "bun:test";
import type { HostDeviceResource } from "@delacour/warden-core/types";
import { ok } from "@delacour/warden-types/result";
import { type TestContext, testContext } from "../testing";
import type { HostLease } from "./claim";
import { hostLeaseHint, pickHostLease, viewHost } from "./view-run";

const ctxs: TestContext[] = [];
afterEach(() => {
	for (const c of ctxs.splice(0)) c.cleanup();
});

function withHostLease(): { ctx: TestContext; lease: HostLease } {
	const ctx = testContext([]);
	ctxs.push(ctx);
	ctx.env.WARDEN_SESSION_ID = "me";
	const resource: HostDeviceResource = {
		kind: "host-device",
		host: "mac",
		remoteLeaseId: "R1",
		platform: "ios",
		id: "UDID-1",
		name: "iPhone 16",
	};
	const lease = ctx.db.insertLease(
		{ resource, owner: { kind: "agent", sessionId: "me", cwd: ctx.cwd }, ttlMs: 60_000 },
		ctx.now()
	);
	return { ctx, lease: { ...lease, resource } };
}

const fakeDriver = () => {
	const state = { closed: false };
	const none = () => Promise.resolve(ok(undefined));
	return {
		state,
		driver: {
			screenshot: () => Promise.resolve(ok({ png: new Uint8Array() })),
			snapshot: () => Promise.reject(new Error("unused")),
			tap: none,
			swipe: none,
			typeText: none,
			key: none,
			pressButton: none,
			close: async () => {
				state.closed = true;
			},
		},
	};
};

describe("pickHostLease", () => {
	test("by id, or the caller's only device lease when it is a host one", () => {
		const { ctx, lease } = withHostLease();
		expect(pickHostLease(ctx, lease.id)?.id).toBe(lease.id);
		expect(pickHostLease(ctx, undefined)?.id).toBe(lease.id);
		expect(pickHostLease(ctx, "nope")).toBeUndefined();
	});
});

describe("hostLeaseHint", () => {
	test("another terminal's host lease is not picked, but named with how to view it", () => {
		const { ctx, lease } = withHostLease();
		ctx.env.WARDEN_SESSION_ID = "another-terminal";
		expect(pickHostLease(ctx, undefined)).toBeUndefined();
		const hint = hostLeaseHint(ctx);
		expect(hint).toContain(`${lease.id} (iPhone 16 on mac)`);
		expect(hint).toContain("warden view <leaseId>");
	});

	test("nothing to say with no host leases", () => {
		const ctx = testContext([]);
		ctxs.push(ctx);
		expect(hostLeaseHint(ctx)).toBeUndefined();
	});
});

describe("viewHost", () => {
	test("prints the page url, holds while the lease lives, then closes the driver and keeps the lease", async () => {
		const { ctx, lease } = withHostLease();
		const f = fakeDriver();
		const stop = new AbortController();
		const opened: string[] = [];
		const code = await viewHost(
			ctx,
			lease,
			{ watch: true, json: false },
			{
				connect: async () => ok(f.driver),
				open: async (_c, url) => {
					opened.push(url);
					stop.abort();
					return true;
				},
				signal: stop.signal,
				tickMs: 5,
			}
		);
		expect(code).toBe(0);
		expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
		expect(ctx.stdout.join("")).toContain(opened[0] ?? "-");
		expect(f.state.closed).toBe(true);
		expect(ctx.db.getLease(lease.id)).toBeDefined();
	});

	test("the lease ending closes the view with exit 11", async () => {
		const { ctx, lease } = withHostLease();
		const f = fakeDriver();
		const code = await viewHost(
			ctx,
			lease,
			{ watch: false, json: true },
			{
				connect: async () => {
					setTimeout(() => ctx.db.deleteLeases([lease.id]), 20);
					return ok(f.driver);
				},
				tickMs: 5,
			}
		);
		expect(code).toBe(11);
		expect(ctx.stderr.join("")).toContain(`lease ${lease.id} ended`);
		expect(JSON.parse(ctx.stdout.join(""))).toMatchObject({ leaseId: lease.id, host: "mac", watch: false });
		expect(f.state.closed).toBe(true);
	});
});
