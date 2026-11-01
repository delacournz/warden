import { expect, test } from "bun:test";
import { claimJsonSchema } from "./claim.schema";
import { e2eReportSchema } from "./e2e-report.schema";
import { checkJsonSchema, lsJsonSchema, uiJsonSchema, uiResultLookup, uiResultSchemas } from "./index";

test("uiJsonSchema discriminates success and failure", () => {
	const ok = { ok: true, command: "snapshot", device: { udid: "U", platform: "ios" }, durationMs: 1, result: {} };
	const bad = { ok: false, command: "press", error: { code: "stale_ref", message: "m" } };
	expect(uiJsonSchema.parse(ok).ok).toBe(true);
	expect(uiJsonSchema.parse(bad).ok).toBe(false);
	expect(() => uiJsonSchema.parse({ ...bad, error: { code: "nope", message: "m" } })).toThrow();
});

test("lsJsonSchema rejects a lease without a state", () => {
	expect(() =>
		lsJsonSchema.parse({
			leases: [
				{
					id: "l",
					resource: { kind: "port", port: 1 },
					owner: { kind: "ci", runId: "r" },
					acquiredAt: 0,
					heartbeatAt: 0,
					ttlMs: 1,
				},
			],
		})
	).toThrow();
});

test("checkJsonSchema requires an owner when someone else holds the device", () => {
	expect(() => checkJsonSchema.parse({ udid: "U", free: false, mine: false, leaseId: "l" })).toThrow();
});

test("uiResultLookup knows every ui command and rejects an unknown one", () => {
	expect(uiResultLookup.schemaFor("snapshot")).toBeDefined();
	expect(uiResultLookup.schemaFor("screen video")).toBeDefined();
	expect(uiResultLookup.schemaFor("toString")).toBeUndefined();
	expect(uiResultLookup.schemaFor("nope")).toBeUndefined();
});

test("per-command ui result schemas accept the shapes the goldens do not reach", () => {
	expect(uiResultSchemas.reload.parse({ action: "reload", method: "expo" }).method).toBe("expo");
	expect(uiResultSchemas.alert.parse({ action: "alert", choice: "accept" })).toBeDefined();
	expect(uiResultSchemas.logs.parse({ action: "logs", mark: "x" })).toBeDefined();
	expect(uiResultSchemas.network.parse({ file: "f", total: 0, entries: [] })).toBeDefined();
	expect(() => uiResultSchemas.reload.parse({ action: "reload", method: "nope" })).toThrow();
	expect(() => uiResultSchemas.press.parse({})).toThrow();
});

test("claimJsonSchema parses a physical claim and a simulator claim", () => {
	const lease = { leaseId: "l", platform: "android", udid: "HW", name: "Pixel", action: "reuse", ttlMs: 1 };
	const parsed = claimJsonSchema.parse({
		leases: [
			{ ...lease, physical: { transport: "usb", hwSerial: "R5" } },
			{ ...lease, udid: "emulator-5554", name: "emu" },
		],
		udids: ["HW", "emulator-5554"],
		reclaimed: [],
	});
	expect(parsed.leases[0]?.physical).toEqual({ transport: "usb", hwSerial: "R5" });
	expect(parsed.leases[1]?.physical).toBeUndefined();
	expect(() => claimJsonSchema.parse({ leases: [{ ...lease, physical: true }], udids: [], reclaimed: [] })).toThrow();
});

test("e2eReportSchema carries a run-level error with its device", () => {
	const base = { suite: "s", platform: "ios", isolate: "device", ok: false, headless: true, specs: [] };
	const parsed = e2eReportSchema.parse({ ...base, error: { code: "device_locked", message: "locked", udid: "U" } });
	expect(parsed.error).toEqual({ code: "device_locked", message: "locked", udid: "U" });
	expect(e2eReportSchema.parse(base).error).toBeUndefined();
	expect(() => e2eReportSchema.parse({ ...base, error: "locked" })).toThrow();
	expect(() => e2eReportSchema.parse({ ...base, error: { code: "x", message: "m" } })).toThrow();
});
