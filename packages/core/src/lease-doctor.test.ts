import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_READY_TIMEOUT_MS } from "./config.defaults";
import {
	applyLeaseFixes,
	diagnoseLeases,
	findingFixable,
	findingSeverity,
	type LeaseDoctorInput,
	type LeaseFinding,
} from "./lease-doctor";
import { instanceId, MARKER_FILE, type MarkerFs } from "./ownership";
import { openStore, type Store } from "./store";
import type { InventoryDevice, Owner } from "./types";

const NOW = 10_000_000;
const MIN = 60_000;
const OWNER: Owner = { kind: "agent", sessionId: "a", cwd: "/" };
const HOME = "/h";
const devDir = (id: string) => `${HOME}/Library/Developer/CoreSimulator/Devices/${id}`;

let dir: string;
let store: Store;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-ldoc-"));
	store = openStore(join(dir, "warden.db"));
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const sim = (
	id: string,
	state: InventoryDevice["state"] = "shutdown",
	name = `warden-iphone-17-${id.length}`
): InventoryDevice => ({
	platform: "ios",
	id,
	name,
	state,
	wardenCreated: false,
});

function memFs(files: Record<string, string> = {}, dirs: string[] = []): MarkerFs {
	return { readText: (p) => files[p], writeText: () => {}, isDir: (p) => dirs.includes(p) };
}

const alive = (set: number[]) => (pid: number) => set.includes(pid);

function input(over: Partial<LeaseDoctorInput> = {}): LeaseDoctorInput {
	return {
		store,
		now: NOW,
		pidAlive: alive([]),
		inventories: { ios: [], android: [] },
		env: { HOME },
		markerFs: memFs(),
		...over,
	};
}

const kinds = (f: LeaseFinding[]) => f.map((x) => x.kind);
const lease = (id: string, over: { pid?: number; name?: string; acquiredAt?: number; ttlMs?: number } = {}) =>
	store.insertLease(
		{
			resource: { kind: "device", platform: "ios", id, name: over.name ?? `warden-iphone-17-${id}` },
			owner: OWNER,
			ttlMs: over.ttlMs ?? 60 * MIN,
			...(over.pid !== undefined ? { pid: over.pid } : {}),
		},
		over.acquiredAt ?? NOW
	);

describe("diagnoseLeases", () => {
	test("clean registry → no findings", () => {
		expect(diagnoseLeases(input())).toEqual([]);
	});

	test("1. a lease on a device missing from the inventory", () => {
		const l = lease("GONE");
		lease("HERE");
		const found = diagnoseLeases(input({ inventories: { ios: [sim("HERE")] } }));
		expect(found).toEqual([
			{ kind: "lease_missing_device", leaseId: l.id, platform: "ios", deviceId: "GONE", name: "warden-iphone-17-GONE" },
		]);
	});

	test("1. a platform whose inventory could not be read is skipped; physical leases are never flagged", () => {
		lease("GONE");
		expect(diagnoseLeases(input({ inventories: {} }))).toEqual([]);
		store.insertLease(
			{
				resource: {
					kind: "device",
					platform: "ios",
					id: "PHONE",
					name: "iPhone",
					physical: { transport: "usb" } as never,
				},
				owner: OWNER,
				ttlMs: MIN,
			},
			NOW
		);
		expect(
			diagnoseLeases(input({ inventories: { ios: [] } })).map((f) => (f as { deviceId?: string }).deviceId)
		).toEqual(["GONE"]);
	});

	test("2. booted warden device: no lease + no record → untracked; leased, recorded, shutdown, foreign are not", () => {
		store.recordDevice({ platform: "ios", id: "REC", name: "warden-iphone-17-1" }, NOW);
		lease("LEASED");
		const inv = [
			sim("NAKED", "booted"),
			sim("REC", "booted"),
			sim("LEASED", "booted"),
			sim("DOWN", "shutdown"),
			sim("USER", "booted", "My iPhone"),
		];
		const found = diagnoseLeases(input({ inventories: { ios: inv } }));
		expect(found.filter((f) => f.kind === "untracked_booted")).toEqual([
			{ kind: "untracked_booted", platform: "ios", deviceId: "NAKED", name: "warden-iphone-17-5" },
		]);
	});

	test("3. a pending placeholder older than the ready timeout with a dead holder; a young or live one is not", () => {
		const old = NOW - DEFAULT_READY_TIMEOUT_MS - MIN;
		const dead = lease("pending:warden-a", { pid: 111, acquiredAt: old, ttlMs: DEFAULT_READY_TIMEOUT_MS });
		lease("pending:warden-b", { pid: 222, acquiredAt: old, ttlMs: 60 * MIN });
		lease("pending:warden-c", { pid: 111, acquiredAt: NOW - MIN });
		const found = diagnoseLeases(input({ pidAlive: alive([222]) }));
		expect(found.filter((f) => f.kind === "stale_placeholder").map((f) => (f as { leaseId: string }).leaseId)).toEqual([
			dead.id,
		]);
		expect(found.some((f) => f.kind === "lease_missing_device")).toBe(false);
	});

	test("4. a queue row with a dead pid", () => {
		const row = {
			platform: "ios" as const,
			profile: "p",
			units: 1,
			priority: 0,
			enqueuedAt: NOW,
			heartbeatAt: NOW,
			owner: OWNER,
		};
		store.enqueue({ id: "dead", pid: 111, ...row });
		store.enqueue({ id: "live", pid: 222, ...row });
		store.enqueue({ id: "nopid", ...row });
		const found = diagnoseLeases(input({ pidAlive: alive([222]) }));
		expect(found).toEqual([{ kind: "dead_queue_row", queueId: "dead", pid: 111 }]);
	});

	test("5. a recorded iOS sim gone from inventory and disk; present on disk is not missing", () => {
		store.recordDevice({ platform: "ios", id: "GONE", name: "warden-iphone-17-1" }, NOW);
		store.recordDevice({ platform: "ios", id: "ONDISK", name: "warden-iphone-17-2" }, NOW);
		const marker = JSON.stringify({ instanceId: instanceId(store), name: "n", createdAt: 1 });
		const fs = memFs({ [`${devDir("ONDISK")}/${MARKER_FILE}`]: marker }, [devDir("ONDISK")]);
		const found = diagnoseLeases(input({ markerFs: fs }));
		expect(found).toEqual([{ kind: "device_missing", platform: "ios", deviceId: "GONE", name: "warden-iphone-17-1" }]);
	});

	test("6. marker: other instance and unreadable mismatch, missing is info, own is clean", () => {
		for (const id of ["OTHER", "BAD", "NONE", "OWN"])
			store.recordDevice({ platform: "ios", id, name: `warden-iphone-17-${id}` }, NOW);
		const own = instanceId(store);
		const m = (instance: string) => JSON.stringify({ instanceId: instance, name: "n", createdAt: 1 });
		const fs = memFs(
			{
				[`${devDir("OTHER")}/${MARKER_FILE}`]: m("someone-else"),
				[`${devDir("BAD")}/${MARKER_FILE}`]: "{nope",
				[`${devDir("OWN")}/${MARKER_FILE}`]: m(own),
			},
			["OTHER", "BAD", "NONE", "OWN"].map(devDir)
		);
		const found = diagnoseLeases(
			input({ markerFs: fs, inventories: { ios: ["OTHER", "BAD", "NONE", "OWN"].map((id) => sim(id)) } })
		);
		expect(
			found
				.map((f) => [f.kind, (f as { deviceId: string }).deviceId, (f as { found?: string }).found])
				.sort((a, b) => String(a[1]).localeCompare(String(b[1])))
		).toEqual([
			["marker_mismatch", "BAD", "unreadable"],
			["marker_missing", "NONE", undefined],
			["marker_mismatch", "OTHER", "someone-else"],
		]);
		expect(findingSeverity({ kind: "marker_missing", platform: "ios", deviceId: "x", name: "x" })).toBe("info");
	});

	test("claim keys: an old key whose claim holds nothing is stale; a young or held one is not", () => {
		const key = (k: string, claimId: string, at: number) =>
			store.setClaimKey({ ownerKey: "agent:a", key: k, claimId, platform: "ios", profile: "p", count: 1 }, at);
		key("old", "c-old", NOW - DEFAULT_READY_TIMEOUT_MS - MIN);
		key("young", "c-young", NOW - MIN);
		key("held", "c-held", NOW - DEFAULT_READY_TIMEOUT_MS - MIN);
		store.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "H", name: "H" },
				owner: OWNER,
				ttlMs: 60 * MIN,
				claimId: "c-held",
			},
			NOW
		);
		const found = diagnoseLeases(input({ inventories: { ios: [sim("H")] } }));
		expect(found).toEqual([{ kind: "stale_claim_key", ownerKey: "agent:a", key: "old", claimId: "c-old" }]);
	});

	test("reclaim state: orphaned unless the device is still quarantined", () => {
		store.recordDevice({ platform: "ios", id: "Q", name: "warden-iphone-17-1" }, NOW);
		store.quarantineDevice({ platform: "ios", id: "Q", name: "warden-iphone-17-1" }, "reclaim: x", NOW);
		store.setMeta("reclaim:ios:Q", "{}");
		store.setMeta("reclaim:ios:GONE", "{}");
		const found = diagnoseLeases(input({ inventories: { ios: [sim("Q")] }, markerFs: memFs({}, [devDir("Q")]) }));
		expect(found.filter((f) => f.kind === "orphan_reclaim_state")).toEqual([
			{ kind: "orphan_reclaim_state", platform: "ios", deviceId: "GONE" },
		]);
	});
});

describe("applyLeaseFixes", () => {
	test("deletes dead leases, placeholders, queue rows, device records, keys, reclaim state; reports the rest unfixed", () => {
		const missing = lease("GONE");
		const old = NOW - DEFAULT_READY_TIMEOUT_MS - MIN;
		const placeholder = lease("pending:warden-a", { pid: 111, acquiredAt: old, ttlMs: DEFAULT_READY_TIMEOUT_MS });
		store.enqueue({
			id: "dead",
			pid: 111,
			platform: "ios",
			profile: "p",
			units: 1,
			priority: 0,
			enqueuedAt: NOW,
			heartbeatAt: NOW,
			owner: OWNER,
		});
		store.recordDevice({ platform: "ios", id: "REC", name: "warden-iphone-17-9" }, NOW);
		store.setClaimKey({ ownerKey: "agent:a", key: "k", claimId: "c", platform: "ios", profile: "p", count: 1 }, old);
		store.setMeta("reclaim:ios:ZZ", "{}");
		const findings: LeaseFinding[] = [...diagnoseLeases(input({ inventories: { ios: [sim("NAKED", "booted")] } }))];
		const kindsBefore = kinds(findings);
		expect(kindsBefore).toEqual(
			expect.arrayContaining([
				"lease_missing_device",
				"stale_placeholder",
				"dead_queue_row",
				"device_missing",
				"stale_claim_key",
				"orphan_reclaim_state",
				"untracked_booted",
			])
		);
		const out = applyLeaseFixes(store, findings, NOW, alive([]));
		expect(kinds(out.unfixed)).toEqual(["untracked_booted"]);
		expect(store.getLease(missing.id)).toBeUndefined();
		expect(store.getLease(placeholder.id)).toBeUndefined();
		expect(store.listQueue()).toEqual([]);
		expect(store.listDevices("ios")).toEqual([]);
		expect(store.getClaimKey("agent:a", "k")).toBeUndefined();
		expect(store.getMeta("reclaim:ios:ZZ")).toBeUndefined();
		expect(findings.every((f) => findingFixable(f) === !out.unfixed.includes(f))).toBe(true);
	});

	test("a live lease on a present device and a foreign device are untouched; no provider is involved", () => {
		const live = lease("HERE");
		store.recordDevice({ platform: "ios", id: "HERE", name: "warden-iphone-17-HERE" }, NOW);
		const inv = [sim("HERE", "booted"), sim("USER", "booted", "My iPhone")];
		const findings = diagnoseLeases(input({ inventories: { ios: inv }, markerFs: memFs({}, [devDir("HERE")]) }));
		applyLeaseFixes(store, findings, NOW, alive([]));
		expect(store.getLease(live.id)).toBeDefined();
		expect(store.listDevices("ios").map((d) => d.id)).toEqual(["HERE"]);
	});

	test("re-checks before deleting: a lease that came back for the device, a revived pid, a re-claimed key", () => {
		const l = lease("GONE");
		store.enqueue({
			id: "q",
			pid: 111,
			platform: "ios",
			profile: "p",
			units: 1,
			priority: 0,
			enqueuedAt: NOW,
			heartbeatAt: NOW,
			owner: OWNER,
		});
		store.recordDevice({ platform: "ios", id: "R", name: "warden-iphone-17-1" }, NOW);
		const findings: LeaseFinding[] = [
			{ kind: "dead_queue_row", queueId: "q", pid: 111 },
			{ kind: "device_missing", platform: "ios", deviceId: "R", name: "warden-iphone-17-1" },
		];
		lease("R");
		const out = applyLeaseFixes(store, findings, NOW, alive([111]));
		expect(out.fixed).toEqual([]);
		expect(store.listQueue()).toHaveLength(1);
		expect(store.listDevices("ios")).toHaveLength(1);
		expect(store.getLease(l.id)).toBeDefined();
	});

	test("a deleted device lease that was granted logs an expired event", () => {
		const l = lease("GONE");
		store.recordEvent({
			at: NOW,
			type: "granted",
			leaseId: l.id,
			data: { platform: "ios", deviceId: "GONE", deviceName: "n", action: "reuse", waitMs: 0 },
		});
		applyLeaseFixes(store, diagnoseLeases(input()), NOW + 5000, alive([]));
		expect(store.listEvents({}).some((e) => e.type === "expired" && e.leaseId === l.id)).toBe(true);
	});
});
