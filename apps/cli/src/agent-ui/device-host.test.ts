import { afterEach, describe, expect, test } from "bun:test";
import type { Lease, Owner } from "@delacour/warden-core/types";
import { OWNER_ENV } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { resolveUiDevice } from "./device";
import { defaultUiDeps } from "./driver";
import { runUi } from "./run";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const ME: Owner = { kind: "agent", sessionId: OWNER_ENV.WARDEN_SESSION_ID ?? "", cwd: "/" };

function setup(owner: Owner = ME): { c: TestContext; lease: Lease } {
	ctx = testContext([]);
	ctx.env = { ...ctx.env, ...OWNER_ENV };
	const lease = ctx.db.insertLease(
		{
			resource: {
				kind: "host-device",
				host: "mac",
				remoteLeaseId: "R1",
				platform: "ios",
				id: "U1",
				name: "warden-iphone-1",
			},
			owner,
			ttlMs: 60_000,
		},
		ctx.now()
	);
	return { c: ctx, lease };
}

describe("resolveUiDevice on a host's device", () => {
	test("the caller's only host lease is the device, with no flags", async () => {
		const { c, lease } = setup();
		const r = await resolveUiDevice(c, {});
		expect(r.success && r.data.lease.id).toBe(lease.id);
		expect(r.success && r.data.udid).toBe("U1");
		expect(r.success && r.data.platform).toBe("ios");
		expect(r.success && r.data.action).toBe("own");
	});

	test("named by --lease or by its udid", async () => {
		const { c, lease } = setup();
		const byLease = await resolveUiDevice(c, { lease: lease.id });
		expect(byLease.success && byLease.data.lease.id).toBe(lease.id);
		const byUdid = await resolveUiDevice(c, { udid: "U1" });
		expect(byUdid.success && byUdid.data.lease.id).toBe(lease.id);
	});

	test("the heartbeat is refreshed", async () => {
		const { c, lease } = setup();
		c.now = () => 1_030_000;
		await resolveUiDevice(c, { lease: lease.id });
		expect(c.db.getLease(lease.id)?.heartbeatAt).toBe(1_030_000);
	});

	test("someone else's host lease is device_foreign", async () => {
		const { c, lease } = setup({ kind: "agent", sessionId: "other", cwd: "/" });
		const r = await resolveUiDevice(c, { lease: lease.id });
		expect(!r.success && r.error.code).toBe("device_foreign");
	});
});

describe("runUi on a host's device", () => {
	test("a verb that runs simctl / adb here is a usage error before any driver opens", async () => {
		const { c } = setup();
		let opened = false;
		const code = await runUi(
			c,
			{
				...defaultUiDeps,
				driver: async () => {
					opened = true;
					return { success: false, error: { code: "failed", message: "x" } };
				},
			},
			"screen rotate",
			{ record: false, json: true },
			async (device) => ({
				success: true,
				data: { device: { udid: device.udid, platform: device.platform }, result: null, text: "" },
			})
		);
		expect(code).toBe(1);
		expect(opened).toBe(false);
		expect(c.stdout.join("")).toContain("does not drive a host's device");
	});
});
