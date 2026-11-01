import { describe, expect, test } from "bun:test";
import { uiClose } from "./close";
import type { UiDevice } from "./device";
import { uiHelper } from "./helper";

const device = (platform: "ios" | "android", udid: string) => ({ platform, udid }) as UiDevice;

describe("stopperFor", () => {
	test("a physical iPhone stops its runner host, a simulator warden-simd, an Android serial its host", () => {
		expect(uiClose.stopperFor(device("ios", "00008140-000A0B0C0D0E0F10"))).toBe(uiHelper.stopIosRunner);
		expect(uiClose.stopperFor(device("ios", "2F1A7B3C-1111-4222-8333-444455556666"))).toBe(uiHelper.stopHelper);
		expect(uiClose.stopperFor(device("android", "R5CT123"))).toBe(uiHelper.stopAndroidHost);
	});
});
