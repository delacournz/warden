import { describe, expect, test } from "bun:test";
import { certainlyOff } from "./opt-out";

describe("certainlyOff", () => {
	const release = "release" as const;

	test("is false for a release build with nothing set", () => {
		expect(certainlyOff({}, release)).toBe(false);
	});

	test("honours the environment opt-outs the client honours", () => {
		expect(certainlyOff({ DO_NOT_TRACK: "1" }, release)).toBe(true);
		expect(certainlyOff({ DO_NOT_TRACK: "true" }, release)).toBe(true);
		expect(certainlyOff({ DELACOUR_TELEMETRY_DISABLED: "1" }, release)).toBe(true);
		expect(certainlyOff({ WARDEN_TELEMETRY_DISABLED: "TRUE" }, release)).toBe(true);
		expect(certainlyOff({ DO_NOT_TRACK: "0" }, release)).toBe(false);
	});

	test("a dev or local build and NODE_ENV=test never report, unless debug lifts that", () => {
		expect(certainlyOff({}, "dev")).toBe(true);
		expect(certainlyOff({}, "local")).toBe(true);
		expect(certainlyOff({ NODE_ENV: "test" }, release)).toBe(true);
		expect(certainlyOff({ DELACOUR_TELEMETRY_DEBUG: "1" }, "dev")).toBe(false);
	});

	test("the debug flag never lifts an explicit opt-out", () => {
		expect(certainlyOff({ DELACOUR_TELEMETRY_DEBUG: "1", DO_NOT_TRACK: "1" }, "dev")).toBe(true);
	});
});
