import { describe, expect, test } from "bun:test";
import type { InventoryDevice } from "@delacour/warden-store/types";
import { inventoryMarker } from "./inventory";

const dev = (id: string, name: string): InventoryDevice => ({
	platform: "ios",
	id,
	name,
	state: "shutdown",
	wardenCreated: false,
});

describe("markWardenDevices", () => {
	test("store record marks device and sets profile", () => {
		const [d] = inventoryMarker.mark(
			[dev("U1", "custom")],
			[{ platform: "ios", id: "U1", name: "custom", profile: "ipad", createdAt: 0, lastUsedAt: 0 }]
		);
		expect(d).toMatchObject({ wardenCreated: true, profile: "ipad" });
	});

	test("warden- name marks device and derives profile", () => {
		const [d] = inventoryMarker.mark([dev("U2", "warden-iphone-17-pro-3")], []);
		expect(d).toMatchObject({ wardenCreated: true, profile: "iphone-17-pro" });
	});

	test("foreign device untouched", () => {
		expect(inventoryMarker.mark([dev("U3", "iPhone 17")], [])[0]?.wardenCreated).toBe(false);
	});

	test("golden devices are not pool devices", () => {
		const golden = { ...dev("G", "warden-golden-iphone-17-abc123def0"), golden: true };
		expect(inventoryMarker.mark([golden], [])[0]?.wardenCreated).toBe(false);
	});

	test("a physical device named warden-x-1 or with a store record stays foreign", () => {
		const phone: InventoryDevice = {
			...dev("P1", "warden-pixel-8-1"),
			platform: "android",
			physical: { platform: "android", transport: "usb", adbState: "device" },
		};
		const [byName] = inventoryMarker.mark([phone], []);
		expect(byName?.wardenCreated).toBe(false);
		const [byRecord] = inventoryMarker.mark(
			[phone],
			[{ platform: "android", id: "P1", name: "x", profile: "p", createdAt: 0, lastUsedAt: 0 }]
		);
		expect(byRecord?.wardenCreated).toBe(false);
		expect(byRecord?.profile).toBeUndefined();
	});
});
