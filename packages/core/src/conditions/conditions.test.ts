import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store";
import type { Owner } from "../types";
import { activeConditions, clearCondition, clearConditions, recordCondition } from "./conditions";

const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/tmp" };

let dir: string;
let store: Store;
let leaseId: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-cond-"));
	store = openStore(join(dir, "warden.db"));
	leaseId = store.insertLease(
		{ resource: { kind: "device", platform: "ios", id: "U1", name: "sim" }, owner, ttlMs: 1000 },
		1
	).id;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("recordCondition / activeConditions", () => {
	test("round-trips a typed value per area", () => {
		const rec = recordCondition(store, leaseId, "network", { kind: "preset", preset: "3g" }, 10);
		expect(rec).toEqual({
			success: true,
			data: { area: "network", value: { kind: "preset", preset: "3g" }, owned: [], setAt: 10 },
		});
		recordCondition(store, leaseId, "location", { kind: "point", lat: 1, lon: 2 }, 11);
		expect(activeConditions(store, leaseId).map((r) => r.area)).toEqual(["network", "location"]);
	});

	test("recording an area again replaces its value", () => {
		recordCondition(store, leaseId, "network", { kind: "offline" }, 10);
		recordCondition(store, leaseId, "network", { kind: "online" }, 20);
		const all = activeConditions(store, leaseId);
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ area: "network", value: { kind: "online" }, setAt: 20 });
	});

	test("owned handles: kept when omitted on a re-record, replaced when given", () => {
		recordCondition(store, leaseId, "network", { kind: "offline" }, 10, [{ kind: "pid", pid: 4242 }]);
		recordCondition(store, leaseId, "network", { kind: "online" }, 11);
		expect(activeConditions(store, leaseId)[0]?.owned).toEqual([{ kind: "pid", pid: 4242 }]);
		recordCondition(store, leaseId, "network", { kind: "online" }, 12, []);
		expect(activeConditions(store, leaseId)[0]?.owned).toEqual([]);
	});

	test("an unknown lease is an error, not a throw", () => {
		const rec = recordCondition(store, "l_nope", "battery", { level: 5 }, 1);
		expect(rec.success).toBe(false);
	});

	test("conditions are per lease", () => {
		const other = store.insertLease({ resource: { kind: "port", port: 8081 }, owner, ttlMs: 1000 }, 1).id;
		recordCondition(store, leaseId, "battery", { level: 5 }, 1);
		expect(activeConditions(store, other)).toEqual([]);
	});
});

describe("clear", () => {
	test("clearCondition removes one area; clearConditions all", () => {
		recordCondition(store, leaseId, "network", { kind: "offline" }, 1);
		recordCondition(store, leaseId, "a11y", { fontScale: 2 }, 1);
		expect(clearCondition(store, leaseId, "network")).toBe(true);
		expect(clearCondition(store, leaseId, "network")).toBe(false);
		expect(activeConditions(store, leaseId).map((r) => r.area)).toEqual(["a11y"]);
		expect(clearConditions(store, leaseId)).toBe(1);
		expect(activeConditions(store, leaseId)).toEqual([]);
	});

	test("deleting the lease drops its conditions", () => {
		recordCondition(store, leaseId, "network", { kind: "offline" }, 1);
		store.deleteLeases([leaseId]);
		expect(store.db.query("SELECT COUNT(*) AS n FROM lease_conditions").get()).toEqual({ n: 0 });
	});
});
