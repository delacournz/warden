import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import type { Owner } from "@delacour/warden-store/types";
import { leaseConditions } from "./conditions";

const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/tmp" };

let dir: string;
let store: Store;
let leaseId: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-cond-"));
	store = storeLocator.open(join(dir, "warden.db"));
	leaseId = store.insertLease(
		{ resource: { kind: "device", platform: "ios", id: "U1", name: "sim" }, owner, ttlMs: 1000 },
		1
	).id;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("record / active", () => {
	test("round-trips a typed value per area", () => {
		const rec = leaseConditions.record(store, leaseId, "network", { kind: "preset", preset: "3g" }, 10);
		expect(rec).toEqual({
			success: true,
			data: { area: "network", value: { kind: "preset", preset: "3g" }, owned: [], setAt: 10 },
		});
		leaseConditions.record(store, leaseId, "location", { kind: "point", lat: 1, lon: 2 }, 11);
		expect(leaseConditions.active(store, leaseId).map((r) => r.area)).toEqual(["network", "location"]);
	});

	test("recording an area again replaces its value", () => {
		leaseConditions.record(store, leaseId, "network", { kind: "offline" }, 10);
		leaseConditions.record(store, leaseId, "network", { kind: "online" }, 20);
		const all = leaseConditions.active(store, leaseId);
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ area: "network", value: { kind: "online" }, setAt: 20 });
	});

	test("owned handles: kept when omitted on a re-record, replaced when given", () => {
		leaseConditions.record(store, leaseId, "network", { kind: "offline" }, 10, [{ kind: "pid", pid: 4242 }]);
		leaseConditions.record(store, leaseId, "network", { kind: "online" }, 11);
		expect(leaseConditions.active(store, leaseId)[0]?.owned).toEqual([{ kind: "pid", pid: 4242 }]);
		leaseConditions.record(store, leaseId, "network", { kind: "online" }, 12, []);
		expect(leaseConditions.active(store, leaseId)[0]?.owned).toEqual([]);
	});

	test("an unknown lease is an error, not a throw", () => {
		const rec = leaseConditions.record(store, "l_nope", "battery", { level: 5 }, 1);
		expect(rec.success).toBe(false);
	});

	test("conditions are per lease", () => {
		const other = store.insertLease({ resource: { kind: "port", port: 8081 }, owner, ttlMs: 1000 }, 1).id;
		leaseConditions.record(store, leaseId, "battery", { level: 5 }, 1);
		expect(leaseConditions.active(store, other)).toEqual([]);
	});
});

describe("clear", () => {
	test("clearCondition removes one area; clearConditions all", () => {
		leaseConditions.record(store, leaseId, "network", { kind: "offline" }, 1);
		leaseConditions.record(store, leaseId, "a11y", { fontScale: 2 }, 1);
		expect(leaseConditions.clear(store, leaseId, "network")).toBe(true);
		expect(leaseConditions.clear(store, leaseId, "network")).toBe(false);
		expect(leaseConditions.active(store, leaseId).map((r) => r.area)).toEqual(["a11y"]);
		expect(leaseConditions.clearAll(store, leaseId)).toBe(1);
		expect(leaseConditions.active(store, leaseId)).toEqual([]);
	});

	test("deleting the lease drops its conditions", () => {
		leaseConditions.record(store, leaseId, "network", { kind: "offline" }, 1);
		store.deleteLeases([leaseId]);
		expect(store.db.query("SELECT COUNT(*) AS n FROM lease_conditions").get()).toEqual({ n: 0 });
	});
});
