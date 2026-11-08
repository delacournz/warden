import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PENDING_PREFIX } from "../claim";
import type { Exec, ExecResult } from "../exec";
import { openStore, type Store } from "../store";
import type { Lease, Owner } from "../types";
import { recordCondition } from "./conditions";
import { orphanConditions, orphanedDevices, undoOrphans } from "./orphans";
import { type UndoDeps, undoConditions } from "./undo";

const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/tmp" };
const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };

let dir: string;
let store: Store;
let calls: string[][];
let proxied: string[];
let fail: (cmd: readonly string[]) => boolean;

function deps(): UndoDeps {
	const exec: Exec = async (cmd) => {
		calls.push([...cmd]);
		return fail(cmd) ? { exitCode: 1, stdout: "", stderr: "offline" } : ok;
	};
	return {
		store,
		exec,
		env: { WARDEN_HOME: dir },
		now: () => 5_000,
		pidAlive: () => false,
		kill: () => {},
		releaseProxy: async (id) => {
			proxied.push(id);
			return true;
		},
	};
}

function lease(platform: "ios" | "android", id: string, resourceId = id): Lease {
	return store.insertLease(
		{ resource: { kind: "device", platform, id: resourceId, name: "dev" }, owner, ttlMs: 1000 },
		1
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-orphans-"));
	store = openStore(join(dir, "warden.db"));
	calls = [];
	proxied = [];
	fail = () => false;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("orphan trigger", () => {
	test("deleting a device lease with conditions moves them to orphan_conditions", () => {
		const l = lease("ios", UDID);
		recordCondition(store, l.id, "a11y", { contrast: "increased" }, 7);
		store.deleteLeases([l.id]);
		const orphans = orphanConditions(store, "ios", UDID);
		expect(orphans.map((o) => [o.leaseId, o.record.area, o.record.setAt])).toEqual([[l.id, "a11y", 7]]);
		expect(store.db.query("SELECT COUNT(*) AS n FROM lease_conditions").get()).toEqual({ n: 0 });
	});

	test("a lease without conditions parks nothing", () => {
		const l = lease("ios", UDID);
		store.deleteLeases([l.id]);
		expect(orphanedDevices(store)).toEqual([]);
	});

	test("a non-device lease and a pending placeholder park nothing", () => {
		const port = store.insertLease({ resource: { kind: "port", port: 19_000 }, owner, ttlMs: 1000 }, 1);
		store.deleteLeases([port.id]);
		const pending = lease("ios", `${PENDING_PREFIX}x`);
		store.deleteLeases([pending.id]);
		expect(orphanedDevices(store)).toEqual([]);
	});

	test("a normal undo then delete leaves no orphan", async () => {
		const l = lease("android", "emulator-5554");
		recordCondition(store, l.id, "battery", { level: 5 }, 7);
		const done = await undoConditions(deps(), l);
		expect(done.success).toBe(true);
		store.deleteLeases([l.id]);
		expect(orphanedDevices(store)).toEqual([]);
	});

	test("an old binary deleting the row with raw SQL still parks the conditions", () => {
		const l = lease("android", "emulator-5554");
		recordCondition(store, l.id, "network", { kind: "offline" }, 7);
		store.db.exec(`DELETE FROM leases WHERE id = '${l.id}'`);
		expect(orphanConditions(store, "android", "emulator-5554")).toHaveLength(1);
	});

	test("stale reclaim parks the conditions", () => {
		const l = lease("android", "emulator-5554");
		recordCondition(store, l.id, "battery", { level: 5 }, 7);
		expect(store.reclaimStale(10_000, () => false)).toEqual([l.id]);
		expect(orphanConditions(store, "android", "emulator-5554")).toHaveLength(1);
	});

	test("the newest lease's condition replaces an older orphan of the same area", () => {
		const a = lease("android", "emulator-5554");
		recordCondition(store, a.id, "battery", { level: 5 }, 7);
		store.deleteLeases([a.id]);
		const b = lease("android", "emulator-5554");
		recordCondition(store, b.id, "battery", { level: 9 }, 8);
		store.deleteLeases([b.id]);
		const [only, ...rest] = orphanConditions(store, "android", "emulator-5554");
		expect(rest).toEqual([]);
		expect(only?.leaseId).toBe(b.id);
	});
});

describe("undoOrphans", () => {
	test("runs the same resets as undo and clears the orphan", async () => {
		const l = lease("android", "emulator-5554");
		recordCondition(store, l.id, "battery", { level: 5 }, 7);
		store.deleteLeases([l.id]);
		const report = await undoOrphans(deps(), { platform: "android", id: "emulator-5554" });
		expect(report).toEqual({ reset: ["battery"], errors: [] });
		expect(calls.some((c) => c.includes("dumpsys") && c.includes("reset"))).toBe(true);
		expect(orphanedDevices(store)).toEqual([]);
	});

	test("a failed reset keeps its orphan row and reports", async () => {
		const l = lease("android", "emulator-5554");
		recordCondition(store, l.id, "battery", { level: 5 }, 7);
		store.deleteLeases([l.id]);
		fail = () => true;
		const report = await undoOrphans(deps(), { platform: "android", id: "emulator-5554" });
		expect(report.reset).toEqual([]);
		expect(report.errors[0]).toContain("battery");
		expect(orphanConditions(store, "android", "emulator-5554")).toHaveLength(1);
		fail = () => false;
		expect((await undoOrphans(deps(), { platform: "android", id: "emulator-5554" })).reset).toEqual(["battery"]);
	});

	test("a network orphan releases the proxy by the old lease id", async () => {
		const l = lease("android", "emulator-5554");
		recordCondition(store, l.id, "network", { kind: "offline" }, 7);
		store.deleteLeases([l.id]);
		await undoOrphans(deps(), { platform: "android", id: "emulator-5554" });
		expect(proxied).toEqual([l.id]);
	});

	test("is idempotent: a second run does nothing", async () => {
		const l = lease("android", "emulator-5554");
		recordCondition(store, l.id, "battery", { level: 5 }, 7);
		store.deleteLeases([l.id]);
		await undoOrphans(deps(), { platform: "android", id: "emulator-5554" });
		calls = [];
		expect(await undoOrphans(deps(), { platform: "android", id: "emulator-5554" })).toEqual({ reset: [], errors: [] });
		expect(calls).toEqual([]);
	});
});
