import { describe, expect, test } from "bun:test";
import { fakeDriver, snapshotOf } from "./driver.testing";
import { canControlKeychainAcl, KEYCHAIN_ACL_UNSUPPORTED, keychainAcl } from "./keychain-acl";

describe("keychainAcl capability", () => {
	test("a driver without it (Android, a physical iPhone) answers E_UNSUPPORTED with why", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([])] });
		expect(canControlKeychainAcl(driver)).toBe(false);
		const result = await keychainAcl(driver, { kind: "on" });
		expect(!result.success && result.error.code).toBe("E_UNSUPPORTED");
		expect(!result.success && result.error.message).toBe(KEYCHAIN_ACL_UNSUPPORTED);
		expect(KEYCHAIN_ACL_UNSUPPORTED).toContain("a physical device enforces ACLs itself");
	});

	test("a driver with it is asked", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([])], keychainAcl: true });
		expect(canControlKeychainAcl(driver)).toBe(true);
		expect(await keychainAcl(driver, { kind: "on" })).toEqual({
			success: true,
			data: { enabled: true, generation: 0 },
		});
		expect(driver.callsOf("keychainAcl").map((c) => c.op.kind)).toEqual(["on"]);
	});
});
