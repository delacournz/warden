import { describe, expect, test } from "bun:test";
import { selectTransport } from "./transport.ts";

describe("selectTransport", () => {
	test("live when ready, http when not", () => {
		expect(selectTransport(true)).toBe("live");
		expect(selectTransport(false)).toBe("http");
	});

	test("a pinned path wins over readiness", () => {
		expect(selectTransport(false, "live")).toBe("live");
		expect(selectTransport(true, "http")).toBe("http");
	});

	test("null pin falls back to readiness", () => {
		expect(selectTransport(true, null)).toBe("live");
	});
});
