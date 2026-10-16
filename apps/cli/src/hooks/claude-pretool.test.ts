import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TTL_MS } from "@delacour/warden-core/config.defaults";
import { openStore, type Store } from "@delacour/warden-core/store";
import type { Owner } from "@delacour/warden-core/types";
import { deviceTarget, type HookDeps, handleSessionEnd } from "./claude-pretool";

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";

let dir: string;
let store: Store;
let now: number;
let pidAlive: (pid: number) => boolean;
let shutdowns: string[][];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-hook-"));
	store = openStore(join(dir, "warden.db"));
	now = 1_000_000;
	pidAlive = () => false;
	shutdowns = [];
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function deps(): HookDeps {
	return {
		store: () => store,
		now: () => now,
		pidAlive: (pid) => pidAlive(pid),
		shutdown: async (leases) => {
			const ids = leases.flatMap((l) => (l.resource.kind === "device" && l.bootedByOwner ? [l.resource.id] : []));
			shutdowns.push(ids);
			return { shutdown: ids, notes: [] };
		},
		endInBackground: () => false,
	};
}

/** A session's lease on a device, as `warden claim` leaves it. */
function lease(id: string, sessionId = "s1", bootedByOwner = false): void {
	store.insertLease(
		{
			resource: { kind: "device", platform: id.startsWith("emulator") ? "android" : "ios", id, name: id },
			owner: { kind: "agent", sessionId, cwd: "/work/cowrie" },
			ttlMs: DEFAULT_TTL_MS,
			...(bootedByOwner ? { bootedByOwner: true } : {}),
		},
		now
	);
}

const other: Owner = { kind: "agent", sessionId: "s2", cwd: "/work/other", repo: "salient", worktree: "other@main" };

describe("deviceTarget", () => {
	test("classifies ids", async () => {
		expect(deviceTarget(UDID)).toEqual({ kind: "device", platform: "ios", id: UDID });
		expect(deviceTarget(UDID.toLowerCase())).toMatchObject({ platform: "ios" });
		expect(deviceTarget("00008030-001A2B3C4D5E6F70")).toMatchObject({ platform: "ios" });
		expect(deviceTarget("emulator-5554")).toEqual({ kind: "device", platform: "android", id: "emulator-5554" });
		expect(deviceTarget("R58M12345AB")).toMatchObject({ platform: "android" });
		expect(deviceTarget("chromium-cdp-9222")).toEqual({ kind: "skip" });
		expect(deviceTarget("")).toEqual({ kind: "skip" });
	});
});

describe("handleSessionEnd", () => {
	test("releases every lease of the session only", async () => {
		lease(UDID);
		lease("emulator-5554");
		store.insertLease(
			{ resource: { kind: "port", port: 8091 }, owner: { kind: "agent", sessionId: "s1", cwd: "/" }, ttlMs: 1 },
			now
		);
		store.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "OTHER", name: "o" }, owner: other, ttlMs: 60_000 },
			now
		);
		const result = await handleSessionEnd({ session_id: "s1", hook_event_name: "SessionEnd", reason: "exit" }, deps());
		expect(result.exitCode).toBe(0);
		expect(store.listLeases().map((l) => l.owner)).toEqual([other]);
	});

	test("malformed input → exit 0, nothing released", async () => {
		store.insertLease({ resource: { kind: "port", port: 1 }, owner: other, ttlMs: 1 }, now);
		expect((await handleSessionEnd("nope", deps())).exitCode).toBe(0);
		expect(store.listLeases()).toHaveLength(1);
	});

	test("shuts down the session's devices it booted (policy decides), then releases", async () => {
		lease(UDID, "s1", true);
		const result = await handleSessionEnd(
			{ session_id: "s1", hook_event_name: "SessionEnd", reason: "prompt_input_exit" },
			deps()
		);
		expect(shutdowns).toEqual([[UDID]]);
		expect(result.stdout).toContain(`shut down ${UDID}`);
		expect(store.listLeases()).toEqual([]);
	});

	test("/clear releases but leaves devices running (the work usually continues)", async () => {
		lease(UDID, "s1", true);
		await handleSessionEnd({ session_id: "s1", hook_event_name: "SessionEnd", reason: "clear" }, deps());
		expect(shutdowns).toEqual([]);
		expect(store.listLeases()).toEqual([]);
	});

	test("shutdown failure still releases", async () => {
		lease(UDID);
		const d = deps();
		d.shutdown = async () => {
			throw new Error("simctl gone");
		};
		expect((await handleSessionEnd({ session_id: "s1", reason: "exit" }, d)).exitCode).toBe(0);
		expect(store.listLeases()).toEqual([]);
	});

	test("background worker available → hand off shutdown + release and return at once (Codex caps SessionEnd at ~3 s)", async () => {
		lease(UDID, "s1", true);
		const handedOff: string[] = [];
		const d = deps();
		d.endInBackground = (sessionId) => {
			handedOff.push(sessionId);
			return true;
		};
		const result = await handleSessionEnd({ session_id: "s1", reason: "other" }, d);
		expect(handedOff).toEqual(["s1"]);
		expect(shutdowns).toEqual([]);
		expect(store.listLeases()).toHaveLength(1);
		expect(result.stdout).toContain("background");
	});

	test("nothing to shut down → no worker, just release", async () => {
		store.insertLease(
			{ resource: { kind: "port", port: 8091 }, owner: { kind: "agent", sessionId: "s1", cwd: "/" }, ttlMs: 1 },
			now
		);
		const d = deps();
		let spawned = false;
		d.endInBackground = () => {
			spawned = true;
			return true;
		};
		await handleSessionEnd({ session_id: "s1", reason: "other" }, d);
		expect(spawned).toBe(false);
		expect(store.listLeases()).toEqual([]);
	});
});
