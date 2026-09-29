import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TTL_MS } from "@warden/core/config.defaults";
import { openStore, type Store } from "@warden/core/store";
import type { Owner } from "@warden/core/types";
import { deviceTarget, type HookDeps, handlePreToolUse, handleSessionEnd } from "./claude-pretool";

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";

let dir: string;
let store: Store;
let now: number;
let pidAlive: (pid: number) => boolean;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-hook-"));
	store = openStore(join(dir, "warden.db"));
	now = 1_000_000;
	pidAlive = () => false;
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
		gitInfo: () => ({ repo: "salient", worktree: "cowrie@feature/x" }),
	};
}

function input(toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	return {
		session_id: "s1",
		cwd: "/work/cowrie",
		hook_event_name: "PreToolUse",
		tool_name: "mcp__argent__gesture-tap",
		tool_input: toolInput,
		...extra,
	};
}

const other: Owner = { kind: "agent", sessionId: "s2", cwd: "/work/other", repo: "salient", worktree: "other@main" };

describe("deviceTarget", () => {
	test("classifies ids", () => {
		expect(deviceTarget(UDID)).toEqual({ kind: "device", platform: "ios", id: UDID });
		expect(deviceTarget(UDID.toLowerCase())).toMatchObject({ platform: "ios" });
		expect(deviceTarget("00008030-001A2B3C4D5E6F70")).toMatchObject({ platform: "ios" });
		expect(deviceTarget("emulator-5554")).toEqual({ kind: "device", platform: "android", id: "emulator-5554" });
		expect(deviceTarget("R58M12345AB")).toMatchObject({ platform: "android" });
		expect(deviceTarget("chromium-cdp-9222")).toEqual({ kind: "skip" });
		expect(deviceTarget("")).toEqual({ kind: "skip" });
	});
});

describe("handlePreToolUse", () => {
	test("non-argent tools and device-less argent tools pass through without leasing", () => {
		expect(handlePreToolUse(input({ udid: UDID }, { tool_name: "Bash" }), deps())).toEqual({ exitCode: 0 });
		expect(handlePreToolUse(input({}, { tool_name: "mcp__argent__list-devices" }), deps())).toEqual({ exitCode: 0 });
		expect(handlePreToolUse(input({ avdName: "Pixel_8" }, { tool_name: "mcp__argent__boot-device" }), deps())).toEqual({
			exitCode: 0,
		});
		expect(handlePreToolUse(input({ udid: "chromium-cdp-9222" }), deps())).toEqual({ exitCode: 0 });
		expect(store.listLeases()).toEqual([]);
	});

	test("unleased device → auto-claim for the session", () => {
		store.recordDevice({ platform: "ios", id: UDID, name: "warden-iphone-17-1", profile: "iphone-17" }, 0);
		expect(handlePreToolUse(input({ udid: UDID }), deps())).toEqual({ exitCode: 0 });
		const [lease] = store.listLeases();
		expect(lease?.resource).toEqual({ kind: "device", platform: "ios", id: UDID, name: "warden-iphone-17-1" });
		expect(lease?.owner).toEqual({
			kind: "agent",
			sessionId: "s1",
			cwd: "/work/cowrie",
			repo: "salient",
			worktree: "cowrie@feature/x",
		});
		expect(lease?.ttlMs).toBe(DEFAULT_TTL_MS);
		expect(lease?.pid).toBeUndefined();
		expect(lease?.label).toBe("claude-hook");
	});

	test("plugin argent tools, device_id and serial are recognised", () => {
		handlePreToolUse(
			input({ device_id: "emulator-5556" }, { tool_name: "mcp__plugin_goldie_argent__describe" }),
			deps()
		);
		now += 1;
		handlePreToolUse(input({ serial: "emulator-5558" }), deps());
		expect(store.listLeases().map((l) => l.resource)).toEqual([
			{ kind: "device", platform: "android", id: "emulator-5556", name: "emulator-5556" },
			{ kind: "device", platform: "android", id: "emulator-5558", name: "emulator-5558" },
		]);
	});

	test("same session → heartbeat", () => {
		handlePreToolUse(input({ udid: UDID }), deps());
		now += 60_000;
		expect(handlePreToolUse(input({ udid: UDID }), deps())).toEqual({ exitCode: 0 });
		const leases = store.listLeases();
		expect(leases).toHaveLength(1);
		expect(leases[0]?.heartbeatAt).toBe(now);
	});

	test("live lease of another owner → block with exit 2", () => {
		store.insertLease(
			{ resource: { kind: "device", platform: "ios", id: UDID, name: "sim" }, owner: other, ttlMs: 60_000 },
			now
		);
		const result = handlePreToolUse(input({ udid: UDID }), deps());
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toBe(
			`device ${UDID} leased by agent s2 (salient/other@main) — run \`warden claim ios\` and use the returned udid`
		);
		expect(store.listLeases()[0]?.owner).toEqual(other);
	});

	test("android block message names the serial", () => {
		store.insertLease(
			{
				resource: { kind: "device", platform: "android", id: "emulator-5554", name: "e" },
				owner: other,
				ttlMs: 60_000,
			},
			now
		);
		const result = handlePreToolUse(input({ serial: "emulator-5554" }), deps());
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("run `warden claim android` and use the returned serial");
	});

	test("user lease kept alive by pid blocks even past ttl", () => {
		const user: Owner = { kind: "user", pid: 4242, cwd: "/work/u" };
		store.insertLease(
			{ resource: { kind: "device", platform: "ios", id: UDID, name: "sim" }, owner: user, ttlMs: 1_000, pid: 4242 },
			now
		);
		now += 10_000;
		pidAlive = (pid) => pid === 4242;
		const result = handlePreToolUse(input({ udid: UDID }), deps());
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("user pid 4242 (/work/u)");
	});

	test("stale lease → reclaimed and auto-claimed", () => {
		store.insertLease(
			{ resource: { kind: "device", platform: "ios", id: UDID, name: "sim" }, owner: other, ttlMs: 1_000 },
			now
		);
		now += 10_000;
		expect(handlePreToolUse(input({ udid: UDID }), deps())).toEqual({ exitCode: 0 });
		const leases = store.listLeases();
		expect(leases).toHaveLength(1);
		expect(leases[0]?.owner).toMatchObject({ kind: "agent", sessionId: "s1" });
	});

	test("malformed input or missing session never blocks", () => {
		for (const bad of [null, "x", 42, {}, { tool_name: "mcp__argent__describe" }, input({ udid: 5 })]) {
			expect(handlePreToolUse(bad, deps()).exitCode).toBe(0);
		}
		expect(handlePreToolUse(input({ udid: UDID }, { session_id: undefined }), deps()).exitCode).toBe(0);
		expect(store.listLeases()).toEqual([]);
	});

	test("git lookup failure still leases (owner without repo)", () => {
		const noGit: HookDeps = {
			...deps(),
			gitInfo: () => {
				throw new Error("ENOENT cwd");
			},
		};
		expect(handlePreToolUse(input({ udid: UDID }), noGit)).toEqual({ exitCode: 0 });
		expect(store.listLeases()[0]?.owner).toEqual({ kind: "agent", sessionId: "s1", cwd: "/work/cowrie" });
	});

	test("store failure → allow with a warning", () => {
		const broken: HookDeps = {
			...deps(),
			store: () => {
				throw new Error("disk full");
			},
		};
		const result = handlePreToolUse(input({ udid: UDID }), broken);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("disk full");
	});
});

describe("handleSessionEnd", () => {
	test("releases every lease of the session only", () => {
		handlePreToolUse(input({ udid: UDID }), deps());
		handlePreToolUse(input({ serial: "emulator-5554" }), deps());
		store.insertLease(
			{ resource: { kind: "port", port: 8091 }, owner: { kind: "agent", sessionId: "s1", cwd: "/" }, ttlMs: 1 },
			now
		);
		store.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "OTHER", name: "o" }, owner: other, ttlMs: 60_000 },
			now
		);
		const result = handleSessionEnd({ session_id: "s1", hook_event_name: "SessionEnd", reason: "exit" }, deps());
		expect(result.exitCode).toBe(0);
		expect(store.listLeases().map((l) => l.owner)).toEqual([other]);
	});

	test("malformed input → exit 0, nothing released", () => {
		store.insertLease({ resource: { kind: "port", port: 1 }, owner: other, ttlMs: 1 }, now);
		expect(handleSessionEnd("nope", deps()).exitCode).toBe(0);
		expect(store.listLeases()).toHaveLength(1);
	});
});
