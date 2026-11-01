import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOT_WAIT_SCRIPT, createAndroidProvider, type SpawnDetached } from "@delacour/warden-providers/android";
import type { ProviderDeps } from "@delacour/warden-providers/provider.types";
import { ADB_DEVICES_EMPTY, EMULATOR_LIST_AVDS } from "@delacour/warden-providers/testing/android.fixtures";
import type { Exec, ExecResult } from "@delacour/warden-runtime/exec";
import { openStore, type Store } from "@delacour/warden-store/store";
import type { Owner } from "@delacour/warden-store/types";
import { ok } from "@delacour/warden-types/result";
import { claimDevices } from "./claim";

const SDK = "/sdk";
const ADB = `${SDK}/platform-tools/adb`;
const EMULATOR = `${SDK}/emulator/emulator`;
const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/tmp" };
const ADB_DEVICES_5554 = "List of devices attached\nemulator-5554          device product:sdk_gphone64_arm64\n";

const out = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

let dir: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-claim-android-"));
	store = openStore(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("claimDevices with the android provider", () => {
	test("a claim of a fresh emulator succeeds when adb lists it only after a few polls", async () => {
		let listed = 0;
		const handlers: Record<string, () => ExecResult> = {
			[`${EMULATOR} -list-avds`]: () => out(EMULATOR_LIST_AVDS),
			// 1: claim inventory (create reuses it), 2-3: boot polls miss, 4: registered
			[`${ADB} devices -l`]: () => (++listed >= 4 ? out(ADB_DEVICES_5554) : out(ADB_DEVICES_EMPTY)),
			[`${ADB} -s emulator-5554 wait-for-device shell ${BOOT_WAIT_SCRIPT}`]: () => out(""),
		};
		const exec: Exec = async (cmd) => {
			const handler = handlers[cmd.join(" ")];
			return handler ? handler() : { exitCode: 1, stdout: "", stderr: `unexpected command: ${cmd.join(" ")}` };
		};
		const deps: ProviderDeps = { exec, store, env: { ANDROID_HOME: SDK, WARDEN_HOME: dir }, now: () => 1_000, owner };
		const spawnDetached: SpawnDetached = async () => ok({ pid: 4242 });
		const provider = createAndroidProvider(deps, { spawnDetached, sleep: async () => {}, pidAlive: () => true });
		const result = await claimDevices({
			store,
			provider,
			owner,
			request: { platform: "android", profile: "pixel-10", count: 1, max: 1 },
			ttlMs: 60_000,
			now: () => 1_000,
			pidAlive: () => false,
			waitMs: 0,
			sleep: async () => {},
		});
		expect(result.success && result.data.claimed.map((c) => [c.action, c.device.id])).toEqual([
			["create", "emulator-5554"],
		]);
		expect(listed).toBe(4);
	});
});
