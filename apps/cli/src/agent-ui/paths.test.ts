import { describe, expect, test } from "bun:test";
import { fsSafeId, uiDir } from "./paths";

describe("fsSafeId / uiDir", () => {
	test("simulator UUIDs, physical UDIDs and emulator serials are unchanged", () => {
		for (const id of [
			"9D8C1F2E-1111-4222-8333-444455556666",
			"00008140-001234567890001C",
			"emulator-5554",
			"R5CT1234ABC",
		]) {
			expect(fsSafeId(id)).toBe(id);
		}
		expect(uiDir({ env: { WARDEN_HOME: "/h" } }, "emulator-5554")).toBe("/h/ui/emulator-5554");
	});

	test("a wifi serial loses its colon and stays distinct from a lookalike", () => {
		const a = fsSafeId("192.168.1.20:5555");
		const b = fsSafeId("192.168.1.20_5555");
		expect(a).not.toContain(":");
		expect(a).not.toBe(b);
		expect(uiDir({ env: { WARDEN_HOME: "/h" } }, "192.168.1.20:5555")).toBe(`/h/ui/${a}`);
	});

	test("path-like ids cannot escape the ui root", () => {
		expect(fsSafeId("../x")).not.toContain("/");
		expect(fsSafeId("..")).not.toBe("..");
	});
});
