import { describe, expect, test } from "bun:test";
import { formatSessionId, isSessionId, type PerfSession, parseSession } from "./session.schema";

const base: PerfSession = {
	version: 1,
	id: "20261024-101530-a1b2c3",
	device: { udid: "U1", platform: "ios", name: "warden-iphone-17-1" },
	target: { udid: "U1", ownedByCaller: true },
	app: { id: "nz.co.delacour.warden.example", source: "flag" },
	startedAt: { wallMs: 1_000 },
	maxDurationMs: 30_000,
	status: "running",
	capturers: [],
	marks: [],
};

describe("session id", () => {
	test("is <yyyymmdd-hhmmss>-<hash6> in UTC", () => {
		expect(formatSessionId(Date.UTC(2026, 9, 24, 10, 15, 30), "a1b2c3")).toBe("20261024-101530-a1b2c3");
	});

	test("isSessionId only accepts that shape (no path traversal)", () => {
		expect(isSessionId("20261024-101530-a1b2c3")).toBe(true);
		expect(isSessionId("../etc")).toBe(false);
		expect(isSessionId("20261024-101530-ZZZZZZ")).toBe(false);
	});
});

describe("parseSession", () => {
	test("round-trips a valid session", () => {
		const parsed = parseSession(JSON.parse(JSON.stringify(base)));
		expect(parsed).toEqual({ success: true, data: base });
	});

	test("accepts capturers, marks and a stop record", () => {
		const full: PerfSession = {
			...base,
			status: "stopped",
			stoppedAt: 5_000,
			stopReason: "max-duration",
			capturers: [{ kind: "collector", pid: 99, startedAtIso: "2026-10-24T10:15:30.000Z", state: "running" }],
			marks: [{ label: "scroll feed", wallMs: 2_000, atMs: 1_000 }],
		};
		expect(parseSession(full)).toEqual({ success: true, data: full });
	});

	test("rejects a bad id, a missing device and an unknown status", () => {
		expect(parseSession({ ...base, id: "nope" }).success).toBe(false);
		expect(parseSession({ ...base, device: undefined }).success).toBe(false);
		expect(parseSession({ ...base, status: "weird" }).success).toBe(false);
		expect(parseSession("garbage").success).toBe(false);
	});
});
