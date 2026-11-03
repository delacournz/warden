import { describe, expect, test } from "bun:test";
import { stopperFor } from "./close";
import type { UiDevice } from "./device";
import { stopAndroidHost, stopHelper, stopIosRunner } from "./helper";

const device = (platform: "ios" | "android", udid: string) => ({ platform, udid }) as UiDevice;

describe("stopperFor", () => {
	test("a physical iPhone stops its runner host, a simulator warden-simd, an Android serial its host", () => {
		expect(stopperFor(device("ios", "00008140-000A0B0C0D0E0F10"))).toBe(stopIosRunner);
		expect(stopperFor(device("ios", "2F1A7B3C-1111-4222-8333-444455556666"))).toBe(stopHelper);
		expect(stopperFor(device("android", "R5CT123"))).toBe(stopAndroidHost);
	});
});
