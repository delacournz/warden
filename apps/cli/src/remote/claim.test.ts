import { afterEach, describe, expect, test } from "bun:test";
import type { Exec } from "@delacour/warden-core/exec";
import type { Owner } from "@delacour/warden-core/types";
import { type TestContext, testContext } from "../testing";
import { fakeServer } from "./api.testing";
import { claimRemote, heartbeatRemoteLeases, stopRemoteLeases } from "./claim";
import { hashMachineId } from "./machine";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/" };

const UUID = "8F1C2D3E-4A5B-6C7D-8E9F-0A1B2C3D4E5F";
const ioreg: Exec = async (cmd) =>
	cmd[0] === "ioreg"
		? { exitCode: 0, stdout: `"IOPlatformUUID" = "${UUID}"`, stderr: "" }
		: { exitCode: 0, stdout: "", stderr: "" };

function setup(server = fakeServer(), exec?: Exec) {
	let t = 1_000_000;
	ctx = testContext([], {
		os: "darwin",
		...(exec ? { exec } : {}),
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
		expect(r).toEqual({
			success: false,
			error: { message: "remote android device rd1 not ready after 10s (stopped it)" },
		});
		expect(server.devices.get("rd1")?.status).toBe("stopped");
		expect(c.db.listLeases()).toEqual([]);
	});

	test("not logged in → the login hint", async () => {
		const c = setup();
		c.env = { ...c.env, WARDEN_TOKEN: undefined };
		const r = await claimRemote(c, { platform: "ios", ttlMs: 60_000, waitMs: 60_000, owner });
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.message).toContain("warden login");
	});

	test("sends the hashed machine id as X-Warden-Machine, never the raw id", async () => {
		const server = fakeServer();
		const c = setup(server, ioreg);
		const r = await claimRemote(c, { platform: "ios", ttlMs: 60_000, waitMs: 60_000, owner });
		expect(r.success).toBe(true);
		const create = server.calls.find((x) => x.method === "POST" && x.path === "/v1/devices");
		expect(create?.machine).toBe(hashMachineId(UUID.toLowerCase()));
		expect(JSON.stringify(server.calls).toLowerCase()).not.toContain(UUID.toLowerCase());
	});

	test("no machine id: claims without the header", async () => {
		const server = fakeServer();
		const c = setup(server);
		await claimRemote(c, { platform: "ios", ttlMs: 60_000, waitMs: 60_000, owner });
		expect(server.calls.find((x) => x.path === "/v1/devices")?.machine).toBeUndefined();
	});

	test("402 CREDITS_EXHAUSTED → credits_exhausted with the top-up link, no lease", async () => {
		const server = fakeServer();
		server.createError = {
			status: 402,
			body: { success: false, code: "CREDITS_EXHAUSTED", error: "no credit", billingUrl: "https://app.test/billing" },
		};
		const c = setup(server);
		const r = await claimRemote(c, { platform: "ios", ttlMs: 60_000, waitMs: 60_000, owner });
		expect(r).toEqual({
			success: false,
			error: {
				code: "credits_exhausted",
				message: "remote claim failed: out of credits; top up at https://app.test/billing",
				billingUrl: "https://app.test/billing",
			},
		});
		expect(c.db.listLeases()).toEqual([]);
	});

	test("403 MACHINE_REQUIRED_FOR_TRIAL → machine_required_for_trial", async () => {
		const server = fakeServer();
		server.createError = { status: 403, body: { success: false, code: "MACHINE_REQUIRED_FOR_TRIAL", error: "x" } };
		const c = setup(server);
		const r = await claimRemote(c, { platform: "ios", ttlMs: 60_000, waitMs: 60_000, owner });
		expect(!r.success && r.error.code).toBe("machine_required_for_trial");
	});

	test("heartbeat warns on a low balance and on a credits_exhausted stop", async () => {
		const server = fakeServer();
		const c = setup(server);
		const r = await claimRemote(c, { platform: "ios", ttlMs: 60_000, waitMs: 60_000, owner });
		if (!r.success) throw new Error(r.error.message);
		const device = server.devices.get("rd1");
		if (!device) throw new Error("no device");
		device.billing = { balanceUsd: 0.3, lowBalance: true };
		expect(await heartbeatRemoteLeases(c, [r.data.lease])).toEqual([
			"remote device rd1: low balance ($0.30 left); top up with: warden billing --top-up",
		]);
		device.status = "stopped";
		device.stopReason = "credits_exhausted";
		expect(await heartbeatRemoteLeases(c, [r.data.lease])).toEqual([
			"remote device rd1 stopped: out of credits; top up with: warden billing --top-up",
		]);
	});

	test("stopRemoteLeases reports a device the server already stopped for credits", async () => {
		const server = fakeServer();
		const c = setup(server);
		const r = await claimRemote(c, { platform: "ios", ttlMs: 60_000, waitMs: 60_000, owner });
		if (!r.success) throw new Error(r.error.message);
		const device = server.devices.get("rd1");
		if (!device) throw new Error("no device");
		device.status = "stopped";
		device.stopReason = "credits_exhausted";
		const out = await stopRemoteLeases(c, [r.data.lease]);
		expect(out.stopReasons).toEqual({ rd1: "credits_exhausted" });
		expect(out.notes).toEqual([
			"remote device rd1 had stopped (stop_reason: credits_exhausted): out of credits; top up with: warden billing --top-up",
		]);
	});

	test("stopRemoteLeases stops each remote device and reports failures", async () => {
		const server = fakeServer();
		const c = setup(server);
		const r = await claimRemote(c, { platform: "ios", ttlMs: 60_000, waitMs: 60_000, owner });
		if (!r.success) throw new Error(r.error.message);
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
		if (!r.success) throw new Error(r.error.message);
		expect(await heartbeatRemoteLeases(c, [r.data.lease])).toEqual([]);
		expect(server.calls.at(-1)).toMatchObject({ method: "POST", path: "/v1/devices/rd1/heartbeat" });
	});
});

describe("leases remember their account and org", () => {
	test("a claim under WARDEN_ORG stamps it on the lease; release elsewhere still sends it", async () => {
		const server = fakeServer();
		const c = setup(server);
		c.env = { ...c.env, WARDEN_ORG: "client" };
		const r = await claimRemote(c, { platform: "ios", ttlMs: 60_000, waitMs: 60_000, owner });
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data.lease.resource).toMatchObject({ kind: "remote-device", organizationId: "client" });
		expect(r.data.billedTo).toEqual({ organization: "client", orgVia: "env" });

		const { WARDEN_ORG: _dropped, ...rest } = c.env;
		c.env = rest;
		server.calls.length = 0;
		await heartbeatRemoteLeases(c, [r.data.lease]);
		await stopRemoteLeases(c, [r.data.lease]);
		expect(server.calls.length).toBeGreaterThan(0);
		expect(server.calls.every((x) => x.organization === "client")).toBe(true);
	});

	test("leases from two orgs are each reached with their own org", async () => {
		const server = fakeServer();
		const c = setup(server);
		const claimIn = async (org: string) => {
			c.env = { ...c.env, WARDEN_ORG: org };
			const r = await claimRemote(c, { platform: "ios", ttlMs: 60_000, waitMs: 60_000, owner });
			if (!r.success) throw new Error(r.error.message);
			return { lease: r.data.lease, id: r.data.device.id };
		};
		const a = await claimIn("org-a");
		const b = await claimIn("org-b");
		server.calls.length = 0;
		const out = await stopRemoteLeases(c, [a.lease, b.lease]);
		expect(out.stopped.sort()).toEqual([a.id, b.id].sort());
		const orgFor = (id: string) => new Set(server.calls.filter((x) => x.path.includes(id)).map((x) => x.organization));
		expect(orgFor(a.id)).toEqual(new Set(["org-a"]));
		expect(orgFor(b.id)).toEqual(new Set(["org-b"]));
	});

	test("a lease from before named accounts uses the caller's current login", async () => {
		const server = fakeServer();
		const c = setup(server);
		const r = await claimRemote(c, { platform: "ios", ttlMs: 60_000, waitMs: 60_000, owner });
		if (!r.success) throw new Error(r.error.message);
		expect(r.data.lease.resource).toEqual({
			kind: "remote-device",
			platform: "ios",
			id: r.data.device.id,
			name: "ios-remote",
		});
		const out = await stopRemoteLeases(c, [r.data.lease]);
		expect(out.stopped).toEqual([r.data.device.id]);
	});
});
