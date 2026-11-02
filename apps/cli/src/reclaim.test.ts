import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TTL_MS } from "@delacour/warden-core/config.defaults";
import type { Exec, ExecResult } from "@delacour/warden-core/exec";
import { RECLAIM_LABEL, RECLAIM_QUARANTINE_PREFIX, readReclaimState } from "@delacour/warden-core/reclaim";
import { openStore, type Store } from "@delacour/warden-core/store";
import type { DeviceResource, Owner } from "@delacour/warden-core/types";
import { releaseDevices } from "./device-lease";
import { retryDueReclaims } from "./reclaim";

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const FOREIGN = "FFFFFFFF-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const GOLDEN = "99999999-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const PHONE = "00008140-001234567890001C";
const me: Owner = { kind: "agent", sessionId: "me", cwd: "/w" };
const dev = (id: string, name = "warden-iphone-17-1"): DeviceResource => ({
	kind: "device",
	platform: "ios",
	id,
	name,
});

const LISTAPPS = `{
    "com.apple.mobilesafari" = {
        ApplicationType = System;
        CFBundleIdentifier = "com.apple.mobilesafari";
    };
    "com.example.app" = {
        ApplicationType = User;
        CFBundleIdentifier = "com.example.app";
    };
}`;

let dir: string;
let store: Store;
let now: number;
let calls: string[][];
let heldDuring: Array<string | undefined>;
let failErase: boolean;

/** fake simctl: records each call and the label of the lease held on UDID at that moment */
const exec: Exec = async (cmd): Promise<ExecResult> => {
	calls.push([...cmd]);
	heldDuring.push(store.findLeaseByResource(dev(UDID))?.label);
	const verb = cmd[2];
	if (verb === "erase" && failErase) return { exitCode: 1, stdout: "", stderr: "boom" };
	if (verb === "listapps") return { exitCode: 0, stdout: LISTAPPS, stderr: "" };
	return { exitCode: 0, stdout: "", stderr: "" };
};

const host = (env: Record<string, string | undefined> = {}) => ({
	store: () => store,
	now: () => now,
	exec,
	env: { WARDEN_HOME: dir, ...env },
});

function lease(resource: DeviceResource): string {
	return store.insertLease({ resource, owner: me, ttlMs: DEFAULT_TTL_MS, pid: 1 }, now).id;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-reclaim-"));
	store = openStore(join(dir, "warden.db"));
	now = 1_000_000;
	calls = [];
	heldDuring = [];
	failErase = false;
	store.recordDevice({ platform: "ios", id: UDID, name: "warden-iphone-17-1", profile: "iphone-17" }, now);
	store.recordDevice({ platform: "ios", id: GOLDEN, name: "warden-golden-iphone-17-abc-r2" }, now);
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const simctl = (verb: string) => calls.filter((c) => c[2] === verb);

describe("reclaim on release", () => {
	test("default none: nothing runs and no reclaiming lease appears", async () => {
		const id = lease(dev(UDID));
		await releaseDevices(host(), [id]);
		expect(calls).toEqual([]);
		expect(store.listLeases()).toEqual([]);
	});

	test("config erase: shutdown + erase under a reclaiming lease, released after", async () => {
		const id = lease(dev(UDID));
		await releaseDevices(host(), [id], { reclaim: "erase" });
		expect(simctl("shutdown")).toHaveLength(1);
		expect(simctl("erase")).toEqual([["xcrun", "simctl", "erase", UDID]]);
		expect(heldDuring.every((l) => l === RECLAIM_LABEL)).toBe(true);
		expect(store.listLeases()).toEqual([]);
		expect(store.listDevices("ios").find((d) => d.id === UDID)?.quarantinedAt).toBeUndefined();
	});

	test("WARDEN_RECLAIM applies when config is silent; config none beats env", async () => {
		await releaseDevices(host({ WARDEN_RECLAIM: "erase" }), [lease(dev(UDID))]);
		expect(simctl("erase")).toHaveLength(1);
		calls = [];
		await releaseDevices(host({ WARDEN_RECLAIM: "erase" }), [lease(dev(UDID))], { reclaim: "none" });
		expect(calls).toEqual([]);
	});

	test("uninstall removes only the user apps", async () => {
		await releaseDevices(host(), [lease(dev(UDID))], { reclaim: "uninstall" });
		expect(simctl("uninstall")).toEqual([["xcrun", "simctl", "uninstall", UDID, "com.example.app"]]);
		expect(simctl("erase")).toEqual([]);
	});

	test("foreign, golden and physical devices are never touched", async () => {
		const notes: string[] = [];
		const ids = [
			lease(dev(FOREIGN, "someone's sim")),
			lease(dev(GOLDEN, "warden-golden-iphone-17-abc-r2")),
			lease(dev(PHONE, "phone")),
		];
		await releaseDevices(host(), ids, { reclaim: "erase", onNote: (n) => notes.push(n) });
		expect(calls).toEqual([]);
		expect(notes).toHaveLength(3);
		expect(notes.some((n) => n.includes("physical"))).toBe(true);
	});

	test("cleanup paths (touch: false, expired leases) never reclaim", async () => {
		await releaseDevices(host(), [lease(dev(UDID))], { reclaim: "erase", touch: false });
		await releaseDevices(host(), [lease(dev(UDID))], { reclaim: "erase", end: "expired" });
		expect(calls).toEqual([]);
	});

	test("a failure quarantines with a reclaim: reason and a 30 s retry, the lease is released", async () => {
		failErase = true;
		const notes: string[] = [];
		await releaseDevices(host(), [lease(dev(UDID))], { reclaim: "erase", onNote: (n) => notes.push(n) });
		const record = store.listDevices("ios").find((d) => d.id === UDID);
		expect(record?.quarantineReason?.startsWith(RECLAIM_QUARANTINE_PREFIX)).toBe(true);
		expect(readReclaimState(store, "ios", UDID)).toEqual({ mode: "erase", tries: 1, nextAt: now + 30_000 });
		expect(store.listLeases()).toEqual([]);
		expect(notes.join("\n")).toContain("warden sim unquarantine");
	});
});

describe("retryDueReclaims (gc)", () => {
	const retry = () => retryDueReclaims(host(), me, async () => undefined);

	test("backoff 30 s, 60 s, then it stays quarantined after 3 tries", async () => {
		failErase = true;
		await releaseDevices(host(), [lease(dev(UDID))], { reclaim: "erase" });
		await retry();
		expect(readReclaimState(store, "ios", UDID)?.tries).toBe(1);

		now += 30_000;
		await retry();
		expect(readReclaimState(store, "ios", UDID)).toEqual({ mode: "erase", tries: 2, nextAt: now + 60_000 });

		now += 59_000;
		await retry();
		expect(readReclaimState(store, "ios", UDID)?.tries).toBe(2);

		now += 1_000;
		await retry();
		const state = readReclaimState(store, "ios", UDID);
		expect(state).toEqual({ mode: "erase", tries: 3 });
		const reason = store.listDevices("ios").find((d) => d.id === UDID)?.quarantineReason;
		expect(reason).toContain("giving up");

		const before = simctl("erase").length;
		now += 10 * 60_000;
		await retry();
		expect(simctl("erase")).toHaveLength(before);
		expect(store.listLeases()).toEqual([]);
	});

	test("a retry that succeeds lifts the quarantine and drops the state", async () => {
		failErase = true;
		await releaseDevices(host(), [lease(dev(UDID))], { reclaim: "erase" });
		failErase = false;
		now += 30_000;
		await retry();
		expect(store.listDevices("ios").find((d) => d.id === UDID)?.quarantinedAt).toBeUndefined();
		expect(readReclaimState(store, "ios", UDID)).toBeUndefined();
	});

	test("a leased device is not retried", async () => {
		failErase = true;
		await releaseDevices(host(), [lease(dev(UDID))], { reclaim: "erase" });
		lease(dev(UDID));
		now += 30_000;
		const before = calls.length;
		await retry();
		expect(calls).toHaveLength(before);
	});
});
