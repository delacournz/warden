import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Exec, ExecResult } from "@delacour/warden-runtime/exec";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import type { Lease, Owner } from "@delacour/warden-store/types";
import { leaseConditions } from "./conditions";
import { injectState } from "./inject-state";
import { launchSettingsFile } from "./launch-settings";
import { ConditionUndo, type UndoDeps } from "./undo";

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
	store = storeLocator.open(join(dir, "warden.db"));
	calls = [];
	killed = [];
	alive = new Set();
	fail = () => false;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("ConditionUndo", () => {
	test("no conditions: runs nothing", async () => {
		const l = lease("ios", UDID);
		const r = await new ConditionUndo(deps()).undo(l);
		expect(r.success).toBe(true);
		expect(calls).toEqual([]);
	});

	test("ios location resets with simctl location clear, then clears the row", async () => {
		const l = lease("ios", UDID);
		leaseConditions.record(store, l.id, "location", { kind: "point", lat: 1, lon: 2 }, 1);
		const r = await new ConditionUndo(deps()).undo(l);
		expect(calls).toEqual([["xcrun", "simctl", "location", UDID, "clear"]]);
		expect(r).toEqual({ success: true, data: { reset: ["location"], killed: [] } });
		expect(leaseConditions.active(store, l.id)).toEqual([]);
	});

	test("ios network has no device state: only owned processes die", async () => {
		const l = lease("ios", UDID);
		alive.add(77);
		leaseConditions.record(store, l.id, "network", { kind: "offline" }, 1, [{ kind: "pid", pid: 77 }]);
		const r = await new ConditionUndo(deps()).undo(l);
		expect(calls).toEqual([]);
		expect(killed).toEqual([77]);
		expect(r).toEqual({ success: true, data: { reset: ["network"], killed: [77] } });
	});

	test("network area calls the injected proxy release; other areas do not", async () => {
		const l = lease("ios", UDID);
		const released: string[] = [];
		const withRelease: UndoDeps = {
			...deps(),
			releaseProxy: async (id) => {
				released.push(id);
				return true;
			},
		};
		leaseConditions.record(store, l.id, "network", { kind: "offline" }, 1);
		leaseConditions.record(store, l.id, "location", { kind: "clear" }, 1);
		const r = await new ConditionUndo(withRelease).undo(l);
		expect(released).toEqual([l.id]);
		expect(r.success).toBe(true);
	});

	test("a failing proxy release keeps the network row and is reported", async () => {
		const l = lease("ios", UDID);
		leaseConditions.record(store, l.id, "network", { kind: "offline" }, 1);
		const r = await new ConditionUndo({
			...deps(),
			releaseProxy: async () => {
				throw new Error("boom");
			},
		}).undo(l);
		expect(r.success).toBe(false);
		expect(leaseConditions.active(store, l.id)).toHaveLength(1);
	});

	test("android network resets speed, delay, airplane mode and proxy", async () => {
		const l = lease("android", "emulator-5554");
		leaseConditions.record(store, l.id, "network", { kind: "preset", preset: "edge" }, 1);
		await new ConditionUndo(deps()).undo(l);
		expect(calls).toEqual([
			[...ADB, "emu", "network", "speed", "full"],
			[...ADB, "emu", "network", "delay", "none"],
			[...ADB, "shell", "cmd", "connectivity", "airplane-mode", "disable"],
			[...ADB, "shell", "settings", "put", "global", "http_proxy", ":0"],
		]);
	});

	test("android battery, a11y and clock resets", async () => {
		const l = lease("android", "emulator-5554");
		leaseConditions.record(store, l.id, "battery", { level: 5 }, 1);
		leaseConditions.record(store, l.id, "a11y", { fontScale: 2 }, 1);
		leaseConditions.record(store, l.id, "clock", { kind: "offset", ms: 1000 }, 1);
		await new ConditionUndo(deps()).undo(l);
		expect(calls).toEqual([
			[...ADB, "shell", "settings", "put", "global", "auto_time", "1"],
			[...ADB, "shell", "cmd", "alarm", "set-time", "5000"],
			[...ADB, "shell", "settings", "put", "system", "font_scale", "1.0"],
			[...ADB, "shell", "settings", "put", "secure", "font_weight_adjustment", "0"],
			[...ADB, "shell", "dumpsys", "battery", "reset"],
		]);
	});

	test("android locale puts the timezone back to the recorded one and clears the app locale", async () => {
		const l = lease("android", "emulator-5554");
		leaseConditions.record(
			store,
			l.id,
			"locale",
			{ timezone: "Asia/Tokyo", previousTimezone: "Europe/London", locale: "fr-FR", bundleId: "x.y" },
			1
		);
		await new ConditionUndo(deps()).undo(l);
		expect(calls).toEqual([
			[...ADB, "shell", "cmd", "alarm", "set-timezone", "Europe/London"],
			[...ADB, "shell", "cmd", "locale", "set-app-locales", "x.y", "--locales", "''"],
		]);
	});

	test("android timezone without a recorded previous one goes to the host's", async () => {
		const l = lease("android", "emulator-5554");
		leaseConditions.record(store, l.id, "locale", { timezone: "Asia/Tokyo" }, 1);
		await new ConditionUndo({ ...deps(), hostTimezone: () => "Pacific/Auckland" }).undo(l);
		expect(calls).toEqual([[...ADB, "shell", "cmd", "alarm", "set-timezone", "Pacific/Auckland"]]);
	});

	test("ios a11y and battery resets", async () => {
		const l = lease("ios", UDID);
		leaseConditions.record(store, l.id, "a11y", { textSize: "accessibility-large" }, 1);
		leaseConditions.record(store, l.id, "battery", { level: 5, cosmetic: true }, 1);
		await new ConditionUndo(deps()).undo(l);
		expect(calls).toEqual([
			["xcrun", "simctl", "ui", UDID, "content_size", "large"],
			["xcrun", "simctl", "ui", UDID, "increase_contrast", "disabled"],
			["xcrun", "simctl", "status_bar", UDID, "clear"],
		]);
	});

	test("ios locale removes the staged launch settings", async () => {
		const home = join(dir, "home");
		const path = launchSettingsFile.path(home, UDID);
		launchSettingsFile.write(path, { timezone: "Asia/Tokyo", locale: "fr-FR" });
		const l = lease("ios", UDID);
		leaseConditions.record(store, l.id, "locale", { timezone: "Asia/Tokyo", locale: "fr-FR" }, 1);
		const r = await new ConditionUndo({ ...deps(), env: { WARDEN_HOME: home } }).undo(l);
		expect(r.success).toBe(true);
		expect(existsSync(path)).toBe(false);
		expect(calls).toEqual([]);
	});

	test("only active areas are reset", async () => {
		const l = lease("android", "emulator-5554");
		leaseConditions.record(store, l.id, "battery", { level: 5 }, 1);
		await new ConditionUndo(deps()).undo(l);
		expect(calls).toEqual([[...ADB, "shell", "dumpsys", "battery", "reset"]]);
	});

	test("idempotent: a second undo runs nothing", async () => {
		const l = lease("ios", UDID);
		leaseConditions.record(store, l.id, "location", { kind: "clear" }, 1);
		await new ConditionUndo(deps()).undo(l);
		calls = [];
		const again = await new ConditionUndo(deps()).undo(l);
		expect(again.success).toBe(true);
		expect(calls).toEqual([]);
	});

	test("a failing reset is collected, keeps its row and does not stop the other areas", async () => {
		const l = lease("android", "emulator-5554");
		leaseConditions.record(store, l.id, "network", { kind: "offline" }, 1);
		leaseConditions.record(store, l.id, "battery", { level: 5 }, 1);
		fail = (cmd) => cmd.includes("airplane-mode");
		const r = await new ConditionUndo(deps()).undo(l);
		expect(r.success).toBe(false);
		if (r.success) return;
		expect(r.error.errors[0]).toContain("airplane-mode");
		expect(r.error.errors[0]).toContain("device offline");
		expect(r.error.report.reset).toEqual(["battery"]);
		expect(leaseConditions.active(store, l.id).map((c) => c.area)).toEqual(["network"]);
		expect(calls).toContainEqual([...ADB, "shell", "dumpsys", "battery", "reset"]);
	});

	test("a thrown exec is collected too", async () => {
		const l = lease("ios", UDID);
		leaseConditions.record(store, l.id, "location", { kind: "clear" }, 1);
		const d = deps();
		const r = await new ConditionUndo({
			...d,
			exec: async () => {
				throw new Error("spawn failed");
			},
		}).undo(l);
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.errors[0]).toContain("spawn failed");
	});

	test("kills only live owned pids", async () => {
		const l = lease("ios", UDID);
		alive.add(10);
		leaseConditions.record(store, l.id, "network", { kind: "offline" }, 1, [
			{ kind: "pid", pid: 10 },
			{ kind: "pid", pid: 11 },
		]);
		const r = await new ConditionUndo(deps()).undo(l);
		expect(killed).toEqual([10]);
		expect(r.success && r.data.killed).toEqual([10]);
	});

	test("never touches a lease that is not a real device lease", async () => {
		const port = store.insertLease({ resource: { kind: "port", port: 8081 }, owner, ttlMs: 1000 }, 1);
		leaseConditions.record(store, port.id, "battery", { level: 5 }, 1);
		const pending = lease("android", "pending:warden-x");
		leaseConditions.record(store, pending.id, "battery", { level: 5 }, 1);
		await new ConditionUndo(deps()).undo(port);
		await new ConditionUndo(deps()).undo(pending);
		expect(calls).toEqual([]);
	});

	test("ios clock writes a neutral state for a still-running injected app", async () => {
		const home = join(dir, "home");
		const path = injectState.path(home, UDID);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ seq: 7, offline: true, clockOffsetMs: 86_400_000, clockFrozenMs: 1 }));
		const l = lease("ios", UDID);
		leaseConditions.record(store, l.id, "clock", { kind: "offset", ms: 86_400_000 }, 1);
		const res = await new ConditionUndo({ ...deps(), env: { WARDEN_HOME: home } }).undo(l);
		expect(res.success).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ seq: 8, offline: false, clockOffsetMs: 0 });
		expect(leaseConditions.active(store, l.id)).toEqual([]);
	});

	test("ios clock with no injected app writes nothing", async () => {
		const home = join(dir, "home");
		const l = lease("ios", UDID);
		leaseConditions.record(store, l.id, "clock", { kind: "offset", ms: 1 }, 1);
		expect((await new ConditionUndo({ ...deps(), env: { WARDEN_HOME: home } }).undo(l)).success).toBe(true);
		expect(existsSync(injectState.path(home, UDID))).toBe(false);
	});

	test("ios permission resets all privacy grants", async () => {
		const l = lease("ios", UDID);
		leaseConditions.record(
			store,
			l.id,
			"permission",
			{ grants: [{ bundleId: "x.y", permission: "location", state: "denied" }] },
			1
		);
		await new ConditionUndo(deps()).undo(l);
		expect(calls).toEqual([["xcrun", "simctl", "privacy", UDID, "reset", "all"]]);
	});
});
