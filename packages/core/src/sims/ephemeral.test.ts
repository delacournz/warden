import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import { type FixtureSim, simctlDevicesJson } from "../providers/ios.fixture";
import { openStore, type Store } from "../store";
import type { Owner } from "../types";
import { sweepEphemeralSims } from "./ephemeral";
import type { SimsDeps } from "./prune";

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
		if (line.startsWith("xcrun simctl shutdown ")) return { exitCode: 0, stdout: "", stderr: "" };
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

const record = (id: string, lastUsedAt = NOW) => {
	store.recordDevice({ platform: "ios", id, name: `warden-iphone-17-${id}` }, lastUsedAt);
};

const deleted = (host: Host) => host.calls.filter((c) => c[2] === "delete").map((c) => c[3]);

describe("sweepEphemeralSims", () => {
	test("deletes every shut-down, unleased warden sim, however recently used; forgets its record", async () => {
		const host: Host = { sims: [sim("A", "warden-iphone-17-A"), sim("B", "warden-iphone-17-B")], calls: [] };
		record("A");
		record("B", NOW - 1);
		const result = await sweepEphemeralSims(deps(host));
		expect(result.success && result.data.removed.map((e) => e.udid)).toEqual(["A", "B"]);
		expect(store.listDevices("ios")).toEqual([]);
	});

	test("an orphan warden-named sim (no record) goes too", async () => {
		const host: Host = { sims: [sim("O", "warden-iphone-17-pro-3")], calls: [] };
		await sweepEphemeralSims(deps(host));
		expect(deleted(host)).toEqual(["O"]);
	});

	test("keeps booted, leased, quarantined, golden and foreign sims", async () => {
		const host: Host = {
			sims: [
				sim("BOOTED", "warden-iphone-17-1", { state: "Booted" }),
				sim("LEASED", "warden-iphone-17-2"),
				sim("Q", "warden-iphone-17-Q"),
				sim("G", "warden-golden-iphone-17-abc"),
				sim("F", "iPhone 17 Pro"),
			],
			calls: [],
		};
		record("Q");
		store.quarantineDevice({ platform: "ios", id: "Q", name: "warden-iphone-17-Q" }, "bad", NOW);
		store.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "LEASED", name: "warden-iphone-17-2" },
				owner: OWNER,
				ttlMs: 60_000,
			},
			NOW
		);
		const result = await sweepEphemeralSims(deps(host));
		expect(result.success && result.data.removed).toEqual([]);
		expect(deleted(host)).toEqual([]);
	});

	test("a sim a claim is still cloning (its name held by a pending placeholder) is kept", async () => {
		const host: Host = { sims: [sim("NEW", "warden-iphone-17-4")], calls: [] };
		store.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "pending:x", name: "warden-iphone-17-4" },
				owner: OWNER,
				ttlMs: 60_000,
			},
			NOW
		);
		await sweepEphemeralSims(deps(host));
		expect(deleted(host)).toEqual([]);
	});

	test("a persistent sim (`warden dev`'s) is kept", async () => {
		const host: Host = { sims: [sim("D", "warden-iphone-17-D")], calls: [] };
		record("D");
		store.markPersistent("ios", "D", NOW);
		await sweepEphemeralSims(deps(host));
		expect(deleted(host)).toEqual([]);
	});

	test("a failed delete is reported; the others still go", async () => {
		const host: Host = {
			sims: [sim("A", "warden-iphone-17-A"), sim("B", "warden-iphone-17-B")],
			calls: [],
			failDelete: "A",
		};
		record("A");
		record("B");
		const result = await sweepEphemeralSims(deps(host));
		expect(result.success && result.data.failed.map((f) => f.entry.udid)).toEqual(["A"]);
		expect(result.success && result.data.removed.map((e) => e.udid)).toEqual(["B"]);
	});
});
