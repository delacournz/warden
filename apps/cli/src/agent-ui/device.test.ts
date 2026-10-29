import { afterEach, describe, expect, test } from "bun:test";
import { OWNER_ENV } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
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
