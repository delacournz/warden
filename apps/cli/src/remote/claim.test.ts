import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@delacour/warden-core/types";
import { type TestContext, testContext } from "../testing";
import { fakeServer } from "./api.testing";
import { claimRemote, heartbeatRemoteLeases, stopRemoteLeases } from "./claim";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/" };

function setup(server = fakeServer()) {
	let t = 1_000_000;
	ctx = testContext([], {
		fetch: server.fetch,
		now: () => t,
		sleep: async (ms) => {
			t += ms;
		},
	});
	ctx.env = { ...ctx.env, WARDEN_API_URL: "https://api.test", WARDEN_TOKEN: server.token };
	return ctx;
}

describe("claimRemote", () => {
	test("creates the device, waits for ready, records a remote-device lease", async () => {
		const server = fakeServer({ readyAfterGets: 3 });
		const c = setup(server);
		const r = await claimRemote(c, {
			platform: "ios",
			profile: "iphone-17",
			ttlMs: 60_000,
			waitMs: 60_000,
			owner,
			label: "x",
		});
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data.device).toMatchObject({ id: "rd1", status: "ready", deviceModel: "iphone-17" });
		expect(r.data.lease.resource).toEqual({ kind: "remote-device", platform: "ios", id: "rd1", name: "iphone-17" });
		expect(c.db.listLeases().map((l) => l.id)).toEqual([r.data.lease.id]);
		expect(server.calls.find((x) => x.method === "POST" && x.path === "/v1/devices")?.body).toEqual({
			platform: "ios",
			deviceModel: "iphone-17",
			idleTimeoutS: 60,
		});
	});

	test("not ready before --wait: stops the device, no lease", async () => {
		const server = fakeServer({ readyAfterGets: 1_000 });
		const c = setup(server);
		const r = await claimRemote(c, { platform: "android", ttlMs: 60_000, waitMs: 10_000, owner });
		expect(r).toEqual({ success: false, error: "remote android device rd1 not ready after 10s (stopped it)" });
		expect(server.devices.get("rd1")?.status).toBe("stopped");
		expect(c.db.listLeases()).toEqual([]);
	});

	test("not logged in → the login hint", async () => {
		const c = setup();
		c.env = { ...c.env, WARDEN_TOKEN: undefined };
		const r = await claimRemote(c, { platform: "ios", ttlMs: 60_000, waitMs: 60_000, owner });
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error).toContain("warden login");
	});

	test("stopRemoteLeases stops each remote device and reports failures", async () => {
		const server = fakeServer();
		const c = setup(server);
		const r = await claimRemote(c, { platform: "ios", ttlMs: 60_000, waitMs: 60_000, owner });
		if (!r.success) throw new Error(r.error);
		const ghost = c.db.insertLease(
			{ resource: { kind: "remote-device", platform: "ios", id: "gone", name: "x" }, owner, ttlMs: 60_000 },
			c.now()
		);
		const out = await stopRemoteLeases(c, [r.data.lease, ghost]);
		expect(out.stopped).toEqual(["rd1"]);
		expect(out.notes).toEqual(["remote device gone: no such device"]);
		expect(server.devices.get("rd1")?.status).toBe("stopped");
	});

	test("heartbeatRemoteLeases pings each remote device", async () => {
		const server = fakeServer();
		const c = setup(server);
		const r = await claimRemote(c, { platform: "ios", ttlMs: 60_000, waitMs: 60_000, owner });
		if (!r.success) throw new Error(r.error);
		expect(await heartbeatRemoteLeases(c, [r.data.lease])).toEqual([]);
		expect(server.calls.at(-1)).toMatchObject({ method: "POST", path: "/v1/devices/rd1/heartbeat" });
	});
});
