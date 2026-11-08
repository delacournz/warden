import { describe, expect, test } from "bun:test";
import { formatElapsed } from "./elapsed";

describe("formatElapsed", () => {
	test("mm:ss.cc from milliseconds", () => {
		expect(formatElapsed(0)).toBe("00:00.00");
		expect(formatElapsed(8050)).toBe("00:08.05");
		expect(formatElapsed(74_130)).toBe("01:14.13");
	});
	test("negative clamps to zero", () => expect(formatElapsed(-5)).toBe("00:00.00"));
});
