import { afterEach, describe, expect, test } from "bun:test";
import { PHONE_PROBE_SCRIPT } from "@delacour/warden-core/providers/android";
import { ADB_DEVICES_STATES, EMULATOR_PROPS, PHONE_PROPS } from "@delacour/warden-core/providers/android.fixtures";
import { OWNER_ENV } from "../simctl.testing";
import { fakeExec, type TestContext, testContext } from "../testing";
import { resolveUiDevice } from "./device";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function setup(): TestContext {
	ctx = testContext([]);
	ctx.env = { ...ctx.env, ...OWNER_ENV };
	return ctx;
}

describe("resolveUiDevice platform from the id", () => {
	test("an id that is no device says simulator, emulator or physical device", async () => {
		const result = await resolveUiDevice(setup(), { udid: "chromium-cdp-9222" });
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.message).toContain("is not a simulator, emulator or physical device");
	});

	test("a physical iOS UDID is ios, so an unleased one asks for a lease rather than failing on its shape", async () => {
		const result = await resolveUiDevice(setup(), { udid: "00008140-001234567890001C" });
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.message).toContain("is not leased");
	});

	test("a lease on a physical device gives its platform and is reused", async () => {
		const c = setup();
		const lease = c.db.insertLease(
			{
				resource: { kind: "device", platform: "android", id: "R5CT", name: "Pixel", physical: { transport: "usb" } },
				owner: { kind: "agent", sessionId: "me", cwd: "/" },
				ttlMs: 60_000,
			},
			c.now()
		);
		const result = await resolveUiDevice(c, { serial: "R5CT" });
		expect(result.success && result.data.lease.id).toBe(lease.id);
		expect(result.success && result.data.platform).toBe("android");
	});
});

describe("resolveUiDevice on Android phones", () => {
	const PHONE = "R5CT1234ABC";
	const probe = (serial: string) => `adb -s ${serial} shell ${PHONE_PROBE_SCRIPT}`;

	function phoneSetup(calls: string[][] = []): TestContext {
		ctx = testContext([], {
			exec: fakeExec(
				[
					["adb devices -l", { stdout: ADB_DEVICES_STATES }],
					[probe(PHONE), { stdout: PHONE_PROPS }],
					[probe("localhost:5555"), { stdout: EMULATOR_PROPS }],
					["adb -s R5CT1234ABC shell getprop sys.boot_completed", { stdout: "1\n" }],
				],
				calls
			),
		});
		ctx.env = { ...ctx.env, ...OWNER_ENV };
		return ctx;
	}

	test("--claim on a phone stamps physical on the new lease", async () => {
		const result = await resolveUiDevice(phoneSetup(), { serial: PHONE, claim: true });
		expect(result.success).toBe(true);
		const lease = ctx?.db.listLeases()[0];
		expect(lease?.resource).toMatchObject({
			kind: "device",
			id: PHONE,
			physical: { transport: "usb", hwSerial: PHONE },
		});
	});

	test("a qemu network emulator is not stamped physical", async () => {
		const result = await resolveUiDevice(phoneSetup(), { serial: "localhost:5555", claim: true });
		expect(result.success).toBe(true);
		const resource = ctx?.db.listLeases()[0]?.resource;
		expect(resource?.kind === "device" && resource.physical).toBeUndefined();
	});

	test("an emulator serial never asks adb what it is", async () => {
		const calls: string[][] = [];
		const result = await resolveUiDevice(phoneSetup(calls), { serial: "emulator-5554", claim: true });
		expect(result.success).toBe(true);
		expect(calls).toEqual([]);
	});

	test("unauthorized phone: device_unauthorized (exit 2), the lease is kept", async () => {
		const result = await resolveUiDevice(phoneSetup(), { serial: "0123456789ABCDEF", claim: true });
		expect(!result.success && result.error.code).toBe("device_unauthorized");
		expect(!result.success && result.error.message).toContain("USB debugging");
		expect(ctx?.db.listLeases()).toHaveLength(1);
	});

	test("offline phone: device_offline", async () => {
		const result = await resolveUiDevice(phoneSetup(), { serial: "ZY22OFFLINE", claim: true });
		expect(!result.success && result.error.code).toBe("device_offline");
		expect(ctx?.db.listLeases()).toHaveLength(1);
	});

	test("--claim --physical with no device named claims a connected phone", async () => {
		const c = phoneSetup();
		c.env = { ...c.env, WARDEN_PHYSICAL_IDS: PHONE };
		const result = await resolveUiDevice(c, { claim: true, physical: true, platform: "android" });
		expect(result.success && result.data.udid).toBe(PHONE);
		const resource = ctx?.db.listLeases()[0]?.resource;
		expect(resource?.kind === "device" && resource.physical?.transport).toBe("usb");
	});

	test("--claim --physical with several ready phones is ambiguous_device with the candidates, and leases nothing", async () => {
		const result = await resolveUiDevice(phoneSetup(), { claim: true, physical: true, platform: "android" });
		expect(!result.success && result.error.code).toBe("ambiguous_device");
		if (result.success) return;
		expect(result.error.hint).toContain("WARDEN_PHYSICAL_IDS");
		const candidates = result.error.details?.candidates as Array<{ id: string }>;
		expect(candidates.map((c) => c.id)).toContain(PHONE);
		expect(candidates.length).toBeGreaterThan(1);
		expect(ctx?.db.listLeases()).toEqual([]);
	});
});
