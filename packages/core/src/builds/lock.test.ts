import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@delacour/warden-types/result";
import { openStore, type Store } from "../store";
import type { Owner } from "../types";
import { type BuildLockDeps, buildLockKey, liveBuildLocks, withBuildLock } from "./lock";
import type { EnsureResult } from "./resolve";

let dir: string;
let store: Store;
const me: Owner = { kind: "agent", sessionId: "me", cwd: "/" };
const other: Owner = { kind: "agent", sessionId: "other", cwd: "/" };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-lock-"));
	store = openStore(join(dir, "warden.db"));
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function deps(over: Partial<BuildLockDeps> = {}): BuildLockDeps & { sleeps: number[] } {
	let clock = 1_000;
	const sleeps: number[] = [];
	return {
		store,
		owner: me,
		pid: 4242,
		now: () => clock,
		pidAlive: () => false,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock += ms;
		},
		pollMs: 100,
		waitMs: 1_000,
		ttlMs: 60_000,
		sleeps,
		...over,
	};
}

describe("withBuildLock", () => {
	test("holds a build lease while fn runs, releases after (also on error)", async () => {
		const d = deps();
		const res = await withBuildLock(d, "k|ios|h", async () => {
			const leases = store.listLeases();
			expect(leases.map((l) => l.resource)).toEqual([{ kind: "build", key: "k|ios|h" }]);
			expect(leases[0]?.pid).toBe(4242);
			return ok(1);
		});
		expect(res).toEqual({ success: true, data: 1 });
		expect(store.listLeases()).toEqual([]);
		expect(await withBuildLock(d, "k|ios|h", async () => err("boom"))).toEqual({ success: false, error: "boom" });
		expect(store.listLeases()).toEqual([]);
	});

	test("waits while another live owner holds it, then runs", async () => {
		const held = store.insertLease({ resource: { kind: "build", key: "k" }, owner: other, ttlMs: 60_000 }, 1_000);
		const logs: string[] = [];
		const d = deps({ log: (l) => logs.push(l) });
		d.sleep = async (ms) => {
			d.sleeps.push(ms);
			if (d.sleeps.length === 3) store.deleteLeases([held.id]);
		};
		const res = await withBuildLock(d, "k", async () => ok("ran"));
		expect(res).toEqual({ success: true, data: "ran" });
		expect(d.sleeps).toEqual([100, 100, 100]);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("agent other");
	});

	test("stale holder (pid dead, heartbeat expired) is reclaimed", async () => {
		store.insertLease({ resource: { kind: "build", key: "k" }, owner: other, ttlMs: 10, pid: 1 }, 0);
		const res = await withBuildLock(deps(), "k", async () => ok("ran"));
		expect(res).toEqual({ success: true, data: "ran" });
	});

	test("times out while held", async () => {
		store.insertLease({ resource: { kind: "build", key: "k" }, owner: other, ttlMs: 10_000_000 }, 1_000);
		const res = await withBuildLock(deps(), "k", async () => ok("never"));
		expect(res.success).toBe(false);
	});

	test("liveBuildLocks lists only live build leases", () => {
		store.insertLease({ resource: { kind: "build", key: "live" }, owner: other, ttlMs: 60_000 }, 1_000);
		store.insertLease({ resource: { kind: "build", key: "dead" }, owner: me, ttlMs: 1 }, 0);
		store.insertLease({ resource: { kind: "port", port: 9 }, owner: me, ttlMs: 60_000 }, 1_000);
		expect([...liveBuildLocks(store, 1_000, () => false)]).toEqual(["live"]);
		expect(buildLockKey("k", "ios", "h")).toBe("k|ios|h");
	});
});

describe("build-lock race (two processes)", () => {
	test("two concurrent resolvers of a missing hash → exactly one download", async () => {
		const home = join(dir, "home");
		const counter = join(dir, "downloads.txt");
		writeFileSync(counter, "");
		openStore(join(home, "warden.db")).close();
		const fixture = join(import.meta.dir, "lock.race-fixture.ts");
		const procs = [0, 1].map(() => Bun.spawn(["bun", fixture, home, counter], { stdout: "pipe", stderr: "pipe" }));
		const outs = await Promise.all(
			procs.map(async (p) => {
				const [out, errText, code] = await Promise.all([
					new Response(p.stdout).text(),
					new Response(p.stderr).text(),
					p.exited,
				]);
				if (code !== 0) throw new Error(errText);
				return JSON.parse(out.trim()) as { success: true; data: EnsureResult };
			})
		);
		const downloads = readFileSync(counter, "utf8").trim().split("\n").filter(Boolean);
		expect(downloads).toHaveLength(1);
		expect(outs.every((o) => o.success)).toBe(true);
		const [a, b] = outs.map((o) => o.data);
		expect(a?.appPath).toBe(b?.appPath ?? "");
		expect([a?.source, b?.source].sort()).toEqual(["cache", "eas"]);
		const check = openStore(join(home, "warden.db"));
		expect(check.listLeases()).toEqual([]);
		check.close();
	}, 20_000);
});
