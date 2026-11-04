import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeConditions } from "@delacour/warden-core/conditions/conditions";
import type { DeviceProvider } from "@delacour/warden-core/providers/provider.types";
import { openStore, type Store } from "@delacour/warden-core/store";
import type { Owner } from "@delacour/warden-core/types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { createAndroidCameraHost } from "./android-camera-host";

const SERIAL = "emulator-5554";
const owner: Owner = { kind: "agent", sessionId: "s", cwd: "/tmp" };

let dir: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-cam-host-"));
	store = openStore(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function provider(log: string[], relaunch: Result<void> = ok(undefined)): DeviceProvider {
	return {
		platform: "android",
		inventory: async () => ok([]),
		create: async () => err("unused"),
		boot: async () => ok(undefined),
		waitReady: async (id, timeoutMs) => {
			log.push(`waitReady ${id} ${timeoutMs}`);
			return ok(undefined);
		},
		shutdown: async () => ok(undefined),
		relaunch: async (id) => {
			log.push(`relaunch ${id}`);
			return relaunch;
		},
	};
}

describe("createAndroidCameraHost", () => {
	test("profile is the one warden recorded for the serial", () => {
		const host = createAndroidCameraHost({
			serial: SERIAL,
			store: () => ok(store),
			provider: () => provider([]),
			now: () => 1,
		});
		expect(host.profile()).toBeUndefined();
		store.recordDevice({ platform: "android", id: SERIAL, name: "w", profile: "pixel-10+cam" }, 1);
		expect(host.profile()).toBe("pixel-10+cam");
	});

	test("relaunch restarts through the provider, then waits until the emulator is ready", async () => {
		const log: string[] = [];
		const host = createAndroidCameraHost({
			serial: SERIAL,
			store: () => ok(store),
			provider: () => provider(log),
			now: () => 1,
		});
		expect(await host.relaunch()).toEqual(ok(undefined));
		expect(log).toEqual([`relaunch ${SERIAL}`, `waitReady ${SERIAL} 180000`]);
	});

	test("a failed relaunch is returned and nothing waits", async () => {
		const log: string[] = [];
		const host = createAndroidCameraHost({
			serial: SERIAL,
			store: () => ok(store),
			provider: () => provider(log, err("did not shut down")),
			now: () => 1,
		});
		expect(await host.relaunch()).toEqual(err("did not shut down"));
		expect(log).toEqual([`relaunch ${SERIAL}`]);
	});

	test("record puts the feeds on the lease of the device; an empty set clears the area", () => {
		const lease = store.insertLease(
			{ resource: { kind: "device", platform: "android", id: SERIAL, name: "w" }, owner, ttlMs: 1000 },
			1
		);
		const host = createAndroidCameraHost({
			serial: SERIAL,
			store: () => ok(store),
			provider: () => provider([]),
			now: () => 7,
		});
		const feeds = { back: { kind: "image", path: "/x/back-1.png" } } as const;
		host.record(feeds);
		expect(activeConditions(store, lease.id).map((c) => [c.area, c.value])).toEqual([["camera", feeds]]);
		host.record({});
		expect(activeConditions(store, lease.id)).toEqual([]);
	});

	test("record without a lease on the device is a no-op", () => {
		const host = createAndroidCameraHost({
			serial: SERIAL,
			store: () => ok(store),
			provider: () => provider([]),
			now: () => 7,
		});
		expect(() => host.record({ back: { kind: "image", path: "/x" } })).not.toThrow();
	});
});
