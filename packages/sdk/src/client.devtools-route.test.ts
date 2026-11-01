import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { facetStubs } from "@delacour/warden-devtools/testing/facet";
import { driverFixtures, FakeDriver } from "@delacour/warden-driver/testing/driver";
import type { DeviceProvider } from "@delacour/warden-providers/provider.types";
import { wardenErrors } from "@delacour/warden-types/error";
import { resultFactory } from "@delacour/warden-types/result";
import { createWardenClient } from "./client";
import type { ClientSeams } from "./core";
import type { WardenClientOptions } from "./sdk.types";

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-sdk-route-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const provider: DeviceProvider = {
	platform: "ios",
	inventory: async () =>
		resultFactory.ok([
			{ platform: "ios", id: UDID, name: "warden-iphone-17-1", state: "booted", wardenCreated: false },
		]),
	create: async () => wardenErrors.err("failed", "no create in this fake"),
	boot: async () => resultFactory.ok(undefined),
	waitReady: async () => resultFactory.ok(undefined),
	shutdown: async () => resultFactory.ok(undefined),
};

function rig(extraEnv: Record<string, string> = {}): { seams: ClientSeams; options: WardenClientOptions } {
	const stub = facetStubs.create();
	return {
		seams: {
			providerFor: () => provider,
			stopHelper: async () => undefined,
			openDriver: async () =>
				resultFactory.ok(
					new FakeDriver({ screens: [driverFixtures.snapshotOf([driverFixtures.el("button", { id: "go" })])] })
				),
			devtools: {
				open: async () =>
					resultFactory.ok({
						...stub.facet,
						evaluate: async () => resultFactory.ok(JSON.stringify({ route: ["__root", "(tabs)", "todos"] })),
					}),
				probe: async () => "ours",
				collector: {
					self: () => ["warden"],
					spawnDetached: () => ({ pid: 1 }),
					kill: () => undefined,
					pidAlive: () => true,
				},
			},
		},
		options: {
			home: dir,
			host: {
				env: {
					WARDEN_CAPACITY: "off",
					WARDEN_ARRANGE: "0",
					WARDEN_BACKGROUND: "0",
					WARDEN_SESSION_ID: "sdk-route",
					WARDEN_HOME: dir,
					HOME: "/nonexistent",
					...extraEnv,
				},
				cwd: dir,
			},
		},
	};
}

describe("session.devtools.route / nativeLogs", () => {
	test("route reads the focused screen through the dev client", async () => {
		const r = rig({ WARDEN_METRO_URL: "http://127.0.0.1:8081" });
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });
		expect(await session.devtools.route()).toBe("(tabs)/todos");
	});

	test("route without a Metro is devtools_unavailable", async () => {
		const r = rig();
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });
		expect(await session.devtools.route().catch((e: unknown) => e)).toMatchObject({ code: "devtools_unavailable" });
	});

	test("nativeLogs without an opened app is a usage error, listed or followed", async () => {
		const r = rig();
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });
		expect(await session.devtools.nativeLogs().catch((e: unknown) => e)).toMatchObject({ code: "usage" });
		const stream = session.devtools.nativeLogs({ follow: true })[Symbol.asyncIterator]();
		expect(await stream.next().catch((e: unknown) => e)).toMatchObject({ code: "usage" });
	});
});
