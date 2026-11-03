import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLACEHOLDER_PNG } from "../camera-placeholder";
import type { Exec, ExecResult } from "../exec";
import { openStore, type Store } from "../store";
import type { Lease, Owner } from "../types";
import { activeConditions, recordCondition } from "./conditions";
import { injectStatePath } from "./inject-state";
import { launchSettingsPath, writeLaunchSettings } from "./launch-settings";
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
		recordCondition(store, l.id, "network", { kind: "offline" }, 1);
		recordCondition(store, l.id, "location", { kind: "clear" }, 1);
		const r = await undoConditions(withRelease, l);
		expect(released).toEqual([l.id]);
		expect(r.success).toBe(true);
	});

	test("a failing proxy release keeps the network row and is reported", async () => {
		const l = lease("ios", UDID);
		recordCondition(store, l.id, "network", { kind: "offline" }, 1);
		const r = await undoConditions(
			{
				...deps(),
				releaseProxy: async () => {
					throw new Error("boom");
				},
			},
			l
		);
		expect(r.success).toBe(false);
		expect(activeConditions(store, l.id)).toHaveLength(1);
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
			[...ADB, "shell", "settings", "put", "secure", "font_weight_adjustment", "0"],
			[...ADB, "shell", "dumpsys", "battery", "reset"],
		]);
	});

	test("android locale puts the timezone back to the recorded one and clears the app locale", async () => {
		const l = lease("android", "emulator-5554");
		recordCondition(
			store,
			l.id,
			"locale",
			{ timezone: "Asia/Tokyo", previousTimezone: "Europe/London", locale: "fr-FR", bundleId: "x.y" },
			1
		);
		await undoConditions(deps(), l);
		expect(calls).toEqual([
			[...ADB, "shell", "cmd", "alarm", "set-timezone", "Europe/London"],
			[...ADB, "shell", "cmd", "locale", "set-app-locales", "x.y", "--locales", "''"],
		]);
	});

	test("android timezone without a recorded previous one goes to the host's", async () => {
		const l = lease("android", "emulator-5554");
		recordCondition(store, l.id, "locale", { timezone: "Asia/Tokyo" }, 1);
		await undoConditions({ ...deps(), hostTimezone: () => "Pacific/Auckland" }, l);
		expect(calls).toEqual([[...ADB, "shell", "cmd", "alarm", "set-timezone", "Pacific/Auckland"]]);
	});

	test("ios a11y and battery resets", async () => {
		const l = lease("ios", UDID);
		recordCondition(store, l.id, "a11y", { textSize: "accessibility-large" }, 1);
		recordCondition(store, l.id, "battery", { level: 5, cosmetic: true }, 1);
		await undoConditions(deps(), l);
		expect(calls).toEqual([
			["xcrun", "simctl", "ui", UDID, "content_size", "large"],
			["xcrun", "simctl", "ui", UDID, "increase_contrast", "disabled"],
			["xcrun", "simctl", "status_bar", UDID, "clear"],
		]);
	});

	test("ios locale removes the staged launch settings", async () => {
		const home = join(dir, "home");
		const path = launchSettingsPath(home, UDID);
		writeLaunchSettings(path, { timezone: "Asia/Tokyo", locale: "fr-FR" });
		const l = lease("ios", UDID);
		recordCondition(store, l.id, "locale", { timezone: "Asia/Tokyo", locale: "fr-FR" }, 1);
		const r = await undoConditions({ ...deps(), env: { WARDEN_HOME: home } }, l);
		expect(r.success).toBe(true);
		expect(existsSync(path)).toBe(false);
		expect(calls).toEqual([]);
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

	test("ios clock writes a neutral state for a still-running injected app", async () => {
		const home = join(dir, "home");
		const path = injectStatePath(home, UDID);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ seq: 7, offline: true, clockOffsetMs: 86_400_000, clockFrozenMs: 1 }));
		const l = lease("ios", UDID);
		recordCondition(store, l.id, "clock", { kind: "offset", ms: 86_400_000 }, 1);
		const res = await undoConditions({ ...deps(), env: { WARDEN_HOME: home } }, l);
		expect(res.success).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ seq: 8, offline: false, clockOffsetMs: 0, camera: {} });
		expect(activeConditions(store, l.id)).toEqual([]);
	});

	test("ios camera blanks the injected app's feeds, removes the staged files and clears the row", async () => {
		const home = join(dir, "home");
		const path = injectStatePath(home, UDID);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({ seq: 3, offline: false, clockOffsetMs: 0, camera: { back: { kind: "image", path: "/x" } } })
		);
		const feeds = join(home, "camera", UDID);
		mkdirSync(feeds, { recursive: true });
		writeFileSync(join(feeds, "back-abc.png"), "x");
		const l = lease("ios", UDID);
		recordCondition(store, l.id, "camera", { back: { kind: "image", path: join(feeds, "back-abc.png") } }, 1);
		const res = await undoConditions({ ...deps(), env: { WARDEN_HOME: home } }, l);
		expect(res).toEqual({ success: true, data: { reset: ["camera"], killed: [] } });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ seq: 4, offline: false, clockOffsetMs: 0, camera: {} });
		expect(existsSync(feeds)).toBe(false);
		expect(calls).toEqual([]);
		expect(activeConditions(store, l.id)).toEqual([]);
	});

	test("ios clock with no injected app writes nothing", async () => {
		const home = join(dir, "home");
		const l = lease("ios", UDID);
		recordCondition(store, l.id, "clock", { kind: "offset", ms: 1 }, 1);
		expect((await undoConditions({ ...deps(), env: { WARDEN_HOME: home } }, l)).success).toBe(true);
		expect(existsSync(injectStatePath(home, UDID))).toBe(false);
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

describe("android camera", () => {
	const SERIAL = "emulator-5554";
	const feedDir = () => join(dir, "camera", SERIAL);
	const camDeps = (): UndoDeps => ({ ...deps(), env: { WARDEN_HOME: dir } });

	function stageFeeds(mode: { back?: string; front?: string }): void {
		mkdirSync(feedDir(), { recursive: true });
		writeFileSync(join(feedDir(), "back.png"), "scene");
		writeFileSync(join(feedDir(), "front.png"), "scene");
		for (const name of Object.values(mode)) writeFileSync(join(feedDir(), name), "video");
		if (Object.keys(mode).length > 0) writeFileSync(join(feedDir(), "mode.json"), JSON.stringify(mode));
	}

	test("image mode: both feeds go back to the grey placeholder, no device command, row cleared", async () => {
		stageFeeds({});
		const l = lease("android", SERIAL);
		recordCondition(store, l.id, "camera", { back: { kind: "image", path: "/x/back-1.png" } }, 1);
		const r = await undoConditions(camDeps(), l);
		expect(r).toEqual({ success: true, data: { reset: ["camera"], killed: [] } });
		expect(calls).toEqual([]);
		expect(readFileSync(join(feedDir(), "back.png")).equals(PLACEHOLDER_PNG)).toBe(true);
		expect(readFileSync(join(feedDir(), "front.png")).equals(PLACEHOLDER_PNG)).toBe(true);
		expect(activeConditions(store, l.id)).toEqual([]);
	});

	test("video mode: videos and mode.json removed and the emulator stopped and forgotten, so the next claim boots in image mode", async () => {
		stageFeeds({ back: "back.mp4" });
		store.recordDevice({ platform: "android", id: SERIAL, name: "w", profile: "pixel-10+cam" }, 1);
		store.insertLease({ resource: { kind: "port", port: 5554 }, owner, ttlMs: 1, label: "emulator w" }, 1);
		const l = lease("android", SERIAL);
		recordCondition(store, l.id, "camera", { back: { kind: "video", path: "/x/back.mp4", loop: true } }, 1);
		const r = await undoConditions(camDeps(), l);
		expect(r.success).toBe(true);
		expect(calls).toEqual([[...ADB, "emu", "kill"]]);
		expect(existsSync(join(feedDir(), "mode.json"))).toBe(false);
		expect(existsSync(join(feedDir(), "back.mp4"))).toBe(false);
		expect(readFileSync(join(feedDir(), "back.png")).equals(PLACEHOLDER_PNG)).toBe(true);
		expect(store.listDevices("android")).toEqual([]);
		expect(store.findLeaseByResource({ kind: "port", port: 5554 })).toBeUndefined();
	});

	test("a failed emulator stop keeps the row and the video mode for the retry", async () => {
		stageFeeds({ front: "front.mov" });
		store.recordDevice({ platform: "android", id: SERIAL, name: "w", profile: "pixel-10+cam" }, 1);
		fail = (cmd) => cmd.includes("kill");
		const l = lease("android", SERIAL);
		recordCondition(store, l.id, "camera", { front: { kind: "video", path: "/x/front.mov", loop: true } }, 1);
		const r = await undoConditions(camDeps(), l);
		expect(r.success).toBe(false);
		expect(existsSync(join(feedDir(), "mode.json"))).toBe(true);
		expect(store.listDevices("android")).toHaveLength(1);
		expect(activeConditions(store, l.id)).toHaveLength(1);
	});
});
