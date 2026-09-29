import { describe, expect, test } from "bun:test";
import { markWardenDevices } from "./inventory";
import type { InventoryDevice } from "./types";

const dev = (id: string, name: string): InventoryDevice => ({
	platform: "ios",
	id,
	name,
	state: "shutdown",
	wardenCreated: false,
});

describe("markWardenDevices", () => {
	test("store record marks device and sets profile", () => {
		const [d] = markWardenDevices(
			[dev("U1", "custom")],
			[{ platform: "ios", id: "U1", name: "custom", profile: "ipad", createdAt: 0, lastUsedAt: 0 }]
		);
		expect(d).toMatchObject({ wardenCreated: true, profile: "ipad" });
	});

	test("warden- name marks device and derives profile", () => {
		const [d] = markWardenDevices([dev("U2", "warden-iphone-17-pro-3")], []);
		expect(d).toMatchObject({ wardenCreated: true, profile: "iphone-17-pro" });
	});

	test("foreign device untouched", () => {
		expect(markWardenDevices([dev("U3", "iPhone 17")], [])[0]?.wardenCreated).toBe(false);
	});
});
