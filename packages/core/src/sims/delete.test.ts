import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import { openStore, type Store } from "../store";
import type { DeviceResource, Owner } from "../types";
import { type DeleteDeps, type DeleteTarget, deleteSims } from "./delete";

const NOW = 1_000_000;
const ME: Owner = { kind: "agent", sessionId: "me", cwd: "/" };
const OTHER: Owner = { kind: "agent", sessionId: "other", cwd: "/" };

let dir: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-sims-delete-"));
	store = openStore(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const resource = (id: string): DeviceResource => ({ kind: "device", platform: "ios", id, name: id });

type Host = { calls: string[]; fail?: Record<string, string>; leasedDuring: boolean[] };

function fakeExec(host: Host): Exec {
	return async (cmd): Promise<ExecResult> => {
		const line = cmd.join(" ");
		host.calls.push(line);
		const udid = cmd[3] ?? "";
		host.leasedDuring.push(store.findLeaseByResource(resource(udid)) !== undefined);
		const failure = host.fail?.[line];
		return failure ? { exitCode: 1, stdout: "", stderr: failure } : { exitCode: 0, stdout: "", stderr: "" };
	};
}

const deps = (host: Host): DeleteDeps => ({ exec: fakeExec(host), store, owner: ME, pid: 42, now: () => NOW });
const target = (udid: string, isAvailable = true): DeleteTarget => ({ udid, name: `sim ${udid}`, isAvailable });
const newHost = (fail?: Record<string, string>): Host => ({ calls: [], leasedDuring: [], ...(fail ? { fail } : {}) });

describe("deleteSims", () => {
	test("shuts down an available sim, deletes it under our lease, forgets it, releases the lease", async () => {
		store.recordDevice({ platform: "ios", id: "A", name: "warden-iphone-17-1" }, NOW);
		const host = newHost();
		const result = await deleteSims(deps(host), [target("A")], { label: "sims prune" });
		expect(result.removed.map((t) => t.udid)).toEqual(["A"]);
		expect(host.calls).toEqual(["xcrun simctl shutdown A", "xcrun simctl delete A"]);
		expect(host.leasedDuring).toEqual([true, true]);
		expect(store.listDevices("ios")).toEqual([]);
		expect(store.listLeases()).toEqual([]);
	});

	test("an unavailable sim is deleted without a shutdown", async () => {
		const host = newHost();
		await deleteSims(deps(host), [target("A", false)], { label: "sims delete" });
		expect(host.calls).toEqual(["xcrun simctl delete A"]);
	});

	test("already shut down is fine", async () => {
		const host = newHost({ "xcrun simctl shutdown A": "Unable to shutdown device in current state: Shutdown" });
		const result = await deleteSims(deps(host), [target("A")], { label: "sims delete" });
		expect(result.removed.map((t) => t.udid)).toEqual(["A"]);
	});

	test("a sim anyone holds a lease on (live or stale) is skipped and its lease left alone", async () => {
		store.insertLease({ resource: resource("A"), owner: OTHER, ttlMs: 60_000 }, NOW);
		store.insertLease({ resource: resource("B"), owner: OTHER, ttlMs: 1 }, 0);
		const host = newHost();
		const result = await deleteSims(deps(host), [target("A"), target("B"), target("C")], { label: "sims delete" });
		expect(result.skipped.map((s) => [s.entry.udid, s.heldBy])).toEqual([
			["A", OTHER],
			["B", OTHER],
		]);
		expect(result.removed.map((t) => t.udid)).toEqual(["C"]);
		expect(host.calls).toEqual(["xcrun simctl shutdown C", "xcrun simctl delete C"]);
		expect(store.listLeases()).toHaveLength(2);
	});

	test("a failed delete is collected, keeps the record, releases the lease and carries on", async () => {
		store.recordDevice({ platform: "ios", id: "A", name: "warden-iphone-17-1" }, NOW);
		const host = newHost({ "xcrun simctl delete A": "boom" });
		const result = await deleteSims(deps(host), [target("A"), target("B")], { label: "sims prune" });
		expect(result.failed.map((f) => f.entry.udid)).toEqual(["A"]);
		expect(result.failed[0]?.error).toContain("boom");
		expect(result.removed.map((t) => t.udid)).toEqual(["B"]);
		expect(store.listDevices("ios").map((r) => r.id)).toEqual(["A"]);
		expect(store.listLeases()).toEqual([]);
	});
});
