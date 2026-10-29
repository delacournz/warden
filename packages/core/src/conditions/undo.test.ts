import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import { openStore, type Store } from "../store";
import type { Lease, Owner } from "../types";
import { activeConditions, recordCondition } from "./conditions";
import { type UndoDeps, undoConditions } from "./undo";

const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/tmp" };
const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const ADB = ["adb", "-s", "emulator-5554"];

let dir: string;
let store: Store;
let calls: string[][];
let killed: number[];
let alive: Set<number>;
let fail: (cmd: readonly string[]) => boolean;

const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };

function deps(): UndoDeps {
	const exec: Exec = async (cmd) => {
		calls.push([...cmd]);
		return fail(cmd) ? { exitCode: 1, stdout: "", stderr: "device offline" } : ok;
	};
	return {
		store,
		exec,
		env: {},
		now: () => 5_000,
		pidAlive: (pid) => alive.has(pid),
		kill: (pid) => {
			killed.push(pid);
			alive.delete(pid);
		},
	};
}

function lease(platform: "ios" | "android", id: string): Lease {
	return store.insertLease({ resource: { kind: "device", platform, id, name: "dev" }, owner, ttlMs: 1000 }, 1);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-undo-"));
	store = openStore(join(dir, "warden.db"));
	calls = [];
	killed = [];
	alive = new Set();
	fail = () => false;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("undoConditions", () => {
	test("no conditions: runs nothing", async () => {
		const l = lease("ios", UDID);
		const r = await undoConditions(deps(), l);
		expect(r.success).toBe(true);
		expect(calls).toEqual([]);
	});

	test("ios location resets with simctl location clear, then clears the row", async () => {
		const l = lease("ios", UDID);
		recordCondition(store, l.id, "location", { kind: "point", lat: 1, lon: 2 }, 1);
		const r = await undoConditions(deps(), l);
		expect(calls).toEqual([["xcrun", "simctl", "location", UDID, "clear"]]);
		expect(r).toEqual({ success: true, data: { reset: ["location"], killed: [] } });
		expect(activeConditions(store, l.id)).toEqual([]);
	});

	test("ios network has no device state: only owned processes die", async () => {
		const l = lease("ios", UDID);
		alive.add(77);
		recordCondition(store, l.id, "network", { kind: "offline" }, 1, [{ kind: "pid", pid: 77 }]);
		const r = await undoConditions(deps(), l);
		expect(calls).toEqual([]);
		expect(killed).toEqual([77]);
		expect(r).toEqual({ success: true, data: { reset: ["network"], killed: [77] } });
	});

	test("android network resets speed, delay, airplane mode and proxy", async () => {
		const l = lease("android", "emulator-5554");
		recordCondition(store, l.id, "network", { kind: "preset", preset: "edge" }, 1);
		await undoConditions(deps(), l);
		expect(calls).toEqual([
			[...ADB, "emu", "network", "speed", "full"],
			[...ADB, "emu", "network", "delay", "none"],
			[...ADB, "shell", "cmd", "connectivity", "airplane-mode", "disable"],
			[...ADB, "shell", "settings", "put", "global", "http_proxy", ":0"],
		]);
	});

	test("android battery, a11y and clock resets", async () => {
		const l = lease("android", "emulator-5554");
		recordCondition(store, l.id, "battery", { level: 5 }, 1);
		recordCondition(store, l.id, "a11y", { fontScale: 2 }, 1);
		recordCondition(store, l.id, "clock", { kind: "offset", ms: 1000 }, 1);
		await undoConditions(deps(), l);
		expect(calls).toEqual([
			[...ADB, "shell", "settings", "put", "global", "auto_time", "1"],
			[...ADB, "shell", "cmd", "alarm", "set-time", "5000"],
			[...ADB, "shell", "settings", "put", "system", "font_scale", "1.0"],
			[...ADB, "shell", "dumpsys", "battery", "reset"],
		]);
	});

	test("only active areas are reset", async () => {
		const l = lease("android", "emulator-5554");
		recordCondition(store, l.id, "battery", { level: 5 }, 1);
		await undoConditions(deps(), l);
		expect(calls).toEqual([[...ADB, "shell", "dumpsys", "battery", "reset"]]);
	});

	test("idempotent: a second undo runs nothing", async () => {
		const l = lease("ios", UDID);
		recordCondition(store, l.id, "location", { kind: "clear" }, 1);
		await undoConditions(deps(), l);
		calls = [];
		const again = await undoConditions(deps(), l);
		expect(again.success).toBe(true);
		expect(calls).toEqual([]);
	});

	test("a failing reset is collected, keeps its row and does not stop the other areas", async () => {
		const l = lease("android", "emulator-5554");
		recordCondition(store, l.id, "network", { kind: "offline" }, 1);
		recordCondition(store, l.id, "battery", { level: 5 }, 1);
		fail = (cmd) => cmd.includes("airplane-mode");
		const r = await undoConditions(deps(), l);
		expect(r.success).toBe(false);
		if (r.success) return;
		expect(r.error.errors[0]).toContain("airplane-mode");
		expect(r.error.errors[0]).toContain("device offline");
		expect(r.error.report.reset).toEqual(["battery"]);
		expect(activeConditions(store, l.id).map((c) => c.area)).toEqual(["network"]);
		expect(calls).toContainEqual([...ADB, "shell", "dumpsys", "battery", "reset"]);
	});

	test("a thrown exec is collected too", async () => {
		const l = lease("ios", UDID);
		recordCondition(store, l.id, "location", { kind: "clear" }, 1);
		const d = deps();
		const r = await undoConditions(
			{
				...d,
				exec: async () => {
					throw new Error("spawn failed");
				},
			},
			l
		);
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.errors[0]).toContain("spawn failed");
	});

	test("kills only live owned pids", async () => {
		const l = lease("ios", UDID);
		alive.add(10);
		recordCondition(store, l.id, "network", { kind: "offline" }, 1, [
			{ kind: "pid", pid: 10 },
			{ kind: "pid", pid: 11 },
		]);
		const r = await undoConditions(deps(), l);
		expect(killed).toEqual([10]);
		expect(r.success && r.data.killed).toEqual([10]);
	});

	test("never touches a lease that is not a real device lease", async () => {
		const port = store.insertLease({ resource: { kind: "port", port: 8081 }, owner, ttlMs: 1000 }, 1);
		recordCondition(store, port.id, "battery", { level: 5 }, 1);
		const pending = lease("android", "pending:warden-x");
		recordCondition(store, pending.id, "battery", { level: 5 }, 1);
		await undoConditions(deps(), port);
		await undoConditions(deps(), pending);
		expect(calls).toEqual([]);
	});

	test("ios permission resets all privacy grants", async () => {
		const l = lease("ios", UDID);
		recordCondition(
			store,
			l.id,
			"permission",
			{ grants: [{ bundleId: "x.y", permission: "location", state: "denied" }] },
			1
		);
		await undoConditions(deps(), l);
		expect(calls).toEqual([["xcrun", "simctl", "privacy", UDID, "reset", "all"]]);
	});
});
