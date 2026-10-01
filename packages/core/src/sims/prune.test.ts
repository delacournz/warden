import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import { type FixtureSim, simctlDevicesJson } from "../providers/ios.fixture";
import { openStore, type Store } from "../store";
import type { Owner } from "../types";
import { auditMachineSims, listAllSims, pruneSims, type SimsDeps } from "./prune";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const GB = 1024 ** 3;
const OWNER: Owner = { kind: "agent", sessionId: "s", cwd: "/" };

let dir: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-sims-"));
	store = openStore(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

type Host = { sims: FixtureSim[]; calls: string[][]; failDelete?: string; onDelete?: (udid: string) => void };

function fakeExec(host: Host): Exec {
	return async (cmd): Promise<ExecResult> => {
		host.calls.push([...cmd]);
		const line = cmd.join(" ");
		if (line === "xcrun simctl list devices -j")
			return { exitCode: 0, stdout: simctlDevicesJson({ "iOS-26-5": host.sims }), stderr: "" };
		if (line.startsWith("xcrun simctl delete ")) {
			const udid = cmd[3] ?? "";
			host.onDelete?.(udid);
			if (udid === host.failDelete) return { exitCode: 1, stdout: "", stderr: "boom" };
			host.sims = host.sims.filter((s) => s.udid !== udid);
			return { exitCode: 0, stdout: "", stderr: "" };
		}
		if (line.startsWith("du -sk ")) return { exitCode: 0, stdout: "2048\t/x\n", stderr: "" };
		return { exitCode: 127, stdout: "", stderr: `unexpected ${line}` };
	};
}

function deps(host: Host): SimsDeps {
	return { exec: fakeExec(host), store, owner: OWNER, pid: process.pid, now: () => NOW, pidAlive: () => true };
}

const sim = (udid: string, name: string, extra: Partial<FixtureSim> = {}): FixtureSim => ({
	udid,
	name,
	state: "Shutdown",
	dataPathSize: GB,
	...extra,
});

const record = (id: string, lastUsedAt: number) => {
	store.recordDevice({ platform: "ios", id, name: `warden-iphone-17-${id}` }, lastUsedAt);
};

describe("listAllSims", () => {
	test("keeps sizes from simctl; falls back to du -sk for a missing dataPathSize", async () => {
		const json = JSON.stringify({
			devices: {
				"com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [
					{ udid: "W", name: "watch", state: "Shutdown", isAvailable: true, dataPath: "/d/W/data" },
				],
			},
		});
		const calls: string[][] = [];
		const exec: Exec = async (cmd) => {
			calls.push([...cmd]);
			if (cmd[0] === "du") return { exitCode: 0, stdout: "2048\t/d/W/data\n", stderr: "" };
			return { exitCode: 0, stdout: json, stderr: "" };
		};
		const sims = await listAllSims(exec);
		expect(sims.success && sims.data.map((s) => [s.udid, s.dataPathSize])).toEqual([["W", 2048 * 1024]]);
		expect(calls).toContainEqual(["du", "-sk", "/d/W/data"]);
	});
});

describe("pruneSims", () => {
	test("dry run deletes nothing", async () => {
		const host: Host = { sims: [sim("A", "warden-iphone-17-1")], calls: [] };
		const result = await pruneSims(deps(host), { idleMs: 7 * DAY, dryRun: true });
		expect(result.success && result.data.removed.map((e) => e.udid)).toEqual(["A"]);
		expect(host.calls.some((c) => c.includes("delete"))).toBe(false);
	});

	test("deletes only warden sims it may, forgets their records, frees bytes", async () => {
		record("A", NOW - 30 * DAY);
		record("R", NOW);
		const host: Host = {
			sims: [
				sim("A", "warden-iphone-17-1"),
				sim("R", "warden-iphone-17-2"),
				sim("F", "foreign", { isAvailable: false }),
				sim("G", "warden-golden-iphone-17-0123456789", { isAvailable: false }),
			],
			calls: [],
		};
		const result = await pruneSims(deps(host), { idleMs: 7 * DAY, dryRun: false });
		expect(result.success && result.data.removed.map((e) => e.udid)).toEqual(["A"]);
		expect(result.success && result.data.freedBytes).toBe(GB);
		expect(host.sims.map((s) => s.udid)).toEqual(["R", "F", "G"]);
		expect(store.listDevices("ios").map((r) => r.id)).toEqual(["R"]);
		expect(store.listLeases()).toEqual([]);
	});

	test("holds a lease on the sim while deleting it, so claim can't take it", async () => {
		const leasedDuring: boolean[] = [];
		const host: Host = {
			sims: [sim("A", "warden-iphone-17-1")],
			calls: [],
			onDelete: (udid) =>
				leasedDuring.push(
					store.findLeaseByResource({ kind: "device", platform: "ios", id: udid, name: "" }) !== undefined
				),
		};
		await pruneSims(deps(host), { idleMs: 7 * DAY, dryRun: false });
		expect(leasedDuring).toEqual([true]);
	});

	test("a sim leased since the audit is skipped", async () => {
		const host: Host = { sims: [sim("A", "warden-iphone-17-1")], calls: [] };
		store.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "A", name: "x" }, owner: OWNER, ttlMs: DAY },
			NOW
		);
		// the audit's lease snapshot predates the claim
		const listLeases = store.listLeases.bind(store);
		store.listLeases = () => [];
		const result = await pruneSims(deps(host), { idleMs: 7 * DAY, dryRun: false });
		store.listLeases = listLeases;
		expect(result.success && result.data.removed).toEqual([]);
		expect(result.success && result.data.skipped.map((e) => e.udid)).toEqual(["A"]);
		expect(host.sims).toHaveLength(1);
		expect(store.listLeases()).toHaveLength(1);
	});

	test("a failed delete is collected, not fatal, and releases its lease", async () => {
		const host: Host = {
			sims: [sim("A", "warden-iphone-17-1"), sim("B", "warden-iphone-17-2")],
			calls: [],
			failDelete: "A",
		};
		const result = await pruneSims(deps(host), { idleMs: 7 * DAY, dryRun: false });
		expect(result.success && result.data.removed.map((e) => e.udid)).toEqual(["B"]);
		expect(result.success && result.data.failed.map((f) => f.entry.udid)).toEqual(["A"]);
		expect(store.listLeases()).toEqual([]);
	});

	test("--max-size removes least-recently-used warden sims", async () => {
		record("A", NOW - 3 * DAY);
		record("B", NOW - DAY);
		const host: Host = { sims: [sim("A", "warden-iphone-17-1"), sim("B", "warden-iphone-17-2")], calls: [] };
		const result = await pruneSims(deps(host), { idleMs: 7 * DAY, dryRun: false, maxBytes: GB });
		expect(result.success && result.data.removed.map((e) => e.udid)).toEqual(["A"]);
	});
});

describe("auditMachineSims", () => {
	test("marks leased sims", async () => {
		store.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "A", name: "x" }, owner: OWNER, ttlMs: DAY },
			NOW
		);
		const host: Host = { sims: [sim("A", "warden-iphone-17-1")], calls: [] };
		const audit = await auditMachineSims(deps(host), { idleMs: 7 * DAY });
		expect(audit.success && audit.data.entries[0]?.verdict).toEqual({ kind: "keep", reason: "leased" });
	});
});
