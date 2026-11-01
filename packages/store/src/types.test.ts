import { describe, expect, test } from "bun:test";
import { type InventoryDevice, leaseModel } from "./types";

const base: InventoryDevice = {
	platform: "android",
	id: "R5CT",
	name: "Pixel 8",
	state: "booted",
	wardenCreated: false,
};

describe("deviceResourceOf", () => {
	test("a virtual device has no physical field", () => {
		expect(leaseModel.deviceResourceOf(base)).toEqual({
			kind: "device",
			platform: "android",
			id: "R5CT",
			name: "Pixel 8",
		});
	});

	test("keeps physical transport and hwSerial for an android phone", () => {
		const phone: InventoryDevice = {
			...base,
			physical: { platform: "android", transport: "wifi", adbState: "device", hwSerial: "HW1" },
		};
		expect(leaseModel.deviceResourceOf(phone)).toEqual({
			kind: "device",
			platform: "android",
			id: "R5CT",
			name: "Pixel 8",
			physical: { transport: "wifi", hwSerial: "HW1" },
		});
	});

	test("an iOS device keeps its transport; the resource key is unchanged by physical", () => {
		const phone: InventoryDevice = {
			platform: "ios",
			id: "00008140-001234567890001C",
			name: "iPhone",
			state: "booted",
			wardenCreated: false,
			physical: {
				platform: "ios",
				transport: "wired",
				deviceType: "iPhone",
				osVersion: "27.2",
				developerMode: true,
				ddi: true,
			},
		};
		const resource = leaseModel.deviceResourceOf(phone);
		expect(resource.physical).toEqual({ transport: "wired" });
		expect(leaseModel.resourceKey(resource)).toBe("device:ios:00008140-001234567890001C");
	});
});

describe("isPhysicalIosId", () => {
	test("hardware UDIDs yes, simulator UUIDs and adb serials no", () => {
		expect(leaseModel.isPhysicalIosId("00008140-001234567890001C")).toBe(true);
		expect(leaseModel.isPhysicalIosId("a".repeat(40))).toBe(true);
		expect(leaseModel.isPhysicalIosId("5F1E9C37-2B7A-4C1D-9E0A-123456789ABC")).toBe(false);
		expect(leaseModel.isPhysicalIosId("emulator-5554")).toBe(false);
		expect(leaseModel.isPhysicalIosId("R5CT")).toBe(false);
	});
});

describe("isPhysicalReady", () => {
	test("android needs adb state device; ios needs booted", () => {
		const android = (adbState: string): InventoryDevice => ({
			...base,
			physical: { platform: "android", transport: "usb", adbState },
		});
		expect(leaseModel.isPhysicalReady(android("device"))).toBe(true);
		expect(leaseModel.isPhysicalReady(android("unauthorized"))).toBe(false);
		expect(leaseModel.isPhysicalReady(base)).toBe(false);
	});
});

describe("physicalNotReadyReason", () => {
	const ios = (
		physical: Partial<Extract<NonNullable<InventoryDevice["physical"]>, { platform: "ios" }>>
	): InventoryDevice => ({
		...base,
		platform: "ios",
		state: "shutdown",
		physical: {
			platform: "ios",
			transport: "localNetwork",
			deviceType: "iPad",
			osVersion: "18.0",
			developerMode: true,
			ddi: true,
			...physical,
		},
	});

	test("an unreachable iOS device is not ready and says offline", () => {
		const d = ios({ unreachable: "not connected" });
		expect(leaseModel.isPhysicalReady({ ...d, state: "booted" })).toBe(false);
		expect(leaseModel.physicalNotReadyReason(d)).toBe("offline: not connected");
	});

	test("names the fix per cause", () => {
		expect(leaseModel.physicalNotReadyReason(ios({ developerMode: false }))).toContain("developer mode off");
		expect(leaseModel.physicalNotReadyReason(ios({ pairingState: "unpaired" }))).toContain("unpaired");
		const android = (adbState: string): InventoryDevice => ({
			...base,
			physical: { platform: "android", transport: "usb", adbState },
		});
		expect(leaseModel.physicalNotReadyReason(android("unauthorized"))).toContain("USB debugging");
		expect(leaseModel.physicalNotReadyReason(android("offline"))).toContain("offline");
		expect(leaseModel.physicalNotReadyReason(android("device"))).toBeUndefined();
	});
});

describe("profileSlug", () => {
	test("lowercases and hyphenates", () => {
		expect(leaseModel.profileSlug("iPhone 17 Pro")).toBe("iphone-17-pro");
		expect(leaseModel.profileSlug("  Pixel_8 API 35 ")).toBe("pixel-8-api-35");
	});
});
