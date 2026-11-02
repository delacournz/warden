import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAIM_QUARANTINE_PREFIX } from "./claim";
import type { Exec } from "./exec";
import { instanceId, type MarkerFs } from "./ownership";
import {
	parseListApps,
	parseReclaimMode,
	parseThirdPartyPackages,
	RECLAIM_QUARANTINE_PREFIX,
	reclaimBackoffMs,
	reclaimDevice,
	reclaimSkipReason,
	resolveReclaim,
	userAppIds,
} from "./reclaim";
import { openStore, type Store } from "./store";

describe("resolveReclaim", () => {
	test("config > WARDEN_RECLAIM > none", () => {
		expect(resolveReclaim({ env: {} })).toBe("none");
		expect(resolveReclaim({ env: { WARDEN_RECLAIM: "erase" } })).toBe("erase");
		expect(resolveReclaim({ config: "uninstall", env: { WARDEN_RECLAIM: "erase" } })).toBe("uninstall");
		expect(resolveReclaim({ config: "none", env: { WARDEN_RECLAIM: "erase" } })).toBe("none");
	});

	test("an unknown env value is ignored", () => {
		expect(resolveReclaim({ env: { WARDEN_RECLAIM: "wipe" } })).toBe("none");
		expect(parseReclaimMode(" Erase ")).toBe("erase");
	});
});

describe("reclaimBackoffMs", () => {
	test("30 s, 60 s, doubling, capped at 5 min", () => {
		expect([1, 2, 3, 4, 5, 6].map(reclaimBackoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
	});
});

test("a reclaim quarantine is not a claim quarantine (24 h lift only touches `claim: `)", () => {
	expect(RECLAIM_QUARANTINE_PREFIX.startsWith(CLAIM_QUARANTINE_PREFIX)).toBe(false);
	expect(CLAIM_QUARANTINE_PREFIX.startsWith(RECLAIM_QUARANTINE_PREFIX)).toBe(false);
});

describe("parsers", () => {
	test("listapps: only User apps that are not Apple's or warden's", () => {
		const text = `{
    "a" = {
        ApplicationType = User;
        CFBundleIdentifier = "com.example.app";
    };
    "b" = {
        ApplicationType = System;
        CFBundleIdentifier = "com.apple.mobilesafari";
    };
    "c" = {
        ApplicationType = User;
        CFBundleIdentifier = "com.apple.TestFlight";
    };
    "d" = {
        ApplicationType = User;
        CFBundleIdentifier = "nz.co.delacour.warden.runner.x";
    };
}`;
		expect(parseListApps(text)).toHaveLength(4);
		expect(userAppIds(text)).toEqual(["com.example.app"]);
	});

	test("pm list packages", () => {
		expect(parseThirdPartyPackages("package:com.a\npackage:com.b\n\n")).toEqual(["com.a", "com.b"]);
	});
});

describe("android and skips", () => {
	let dir: string;
	let store: Store;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-reclaim-core-"));
		store = openStore(join(dir, "warden.db"));
		store.recordDevice({ platform: "android", id: "emulator-5554", name: "warden-pixel-1" }, 1);
	});
	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("erase on an emulator uninstalls the third-party packages (documented fallback)", async () => {
		const calls: string[][] = [];
		const exec: Exec = async (cmd) => {
			calls.push([...cmd]);
			return { exitCode: 0, stdout: cmd.includes("list") ? "package:com.a\npackage:com.b\n" : "Success", stderr: "" };
		};
		const out = await reclaimDevice({ exec, store, env: {}, now: () => 1 }, "android", "emulator-5554", "erase");
		expect(out.kind).toBe("done");
		expect(calls.filter((c) => c.includes("uninstall")).map((c) => c.at(-1))).toEqual(["com.a", "com.b"]);
	});

	test("a physical phone and an unrecorded emulator are skipped", () => {
		expect(reclaimSkipReason(store, "android", "R58M123ABC", false)).toContain("physical");
		expect(reclaimSkipReason(store, "android", "emulator-5556", false)).toContain("not a warden device");
		expect(reclaimSkipReason(store, "android", "emulator-5554", true)).toContain("physical");
		expect(reclaimSkipReason(store, "android", "emulator-5554", false)).toBeUndefined();
	});

	test("a human quarantine is kept as it is", () => {
		store.quarantineDevice({ platform: "android", id: "emulator-5554", name: "warden-pixel-1" }, "bad", 2);
		expect(reclaimSkipReason(store, "android", "emulator-5554", false)).toContain("quarantined");
	});
});

describe("ios erase honours the ownership marker", () => {
	let dir: string;
	let store: Store;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-reclaim-marker-"));
		store = openStore(join(dir, "warden.db"));
		store.recordDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1" }, 1);
	});
	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const devDir = "/h/Library/Developer/CoreSimulator/Devices/U1";
	const fsWith = (text: string | undefined): MarkerFs => ({
		readText: (p) => (p === `${devDir}/.warden-owned.json` ? text : undefined),
		writeText: () => {},
		isDir: () => true,
	});
	const run = async (markerFs: MarkerFs) => {
		const calls: string[] = [];
		const exec: Exec = async (cmd) => {
			calls.push(cmd.join(" "));
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		const out = await reclaimDevice({ exec, store, env: { HOME: "/h" }, now: () => 1, markerFs }, "ios", "U1", "erase");
		return { out, calls };
	};

	test("another instance's marker: skipped, nothing run", async () => {
		const { out, calls } = await run(fsWith(JSON.stringify({ instanceId: "other", name: "n", createdAt: 1 })));
		expect(out).toEqual({ kind: "skipped", reason: expect.stringContaining("another warden") });
		expect(calls).toEqual([]);
	});

	test("missing or matching marker: erased", async () => {
		expect((await run(fsWith(undefined))).calls).toEqual(["xcrun simctl shutdown U1", "xcrun simctl erase U1"]);
		const own = JSON.stringify({ instanceId: instanceId(store), name: "n", createdAt: 1 });
		expect((await run(fsWith(own))).out.kind).toBe("done");
	});
});
