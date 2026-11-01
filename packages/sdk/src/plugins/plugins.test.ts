import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverConformance } from "@delacour/warden-driver/testing/conformance";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import { fakeFarm, fakeFarmDriver } from "../../examples/fake-provider";
import { createWardenClient } from "../client";
import { isWardenError } from "../errors";
import type { WardenClientOptions, WardenEvent } from "../sdk.types";
import { defineProvider, type ProviderPlugin } from "./define-provider";

const ENV = {
	WARDEN_CAPACITY: "off",
	WARDEN_ARRANGE: "0",
	WARDEN_BACKGROUND: "0",
	WARDEN_SESSION_ID: "sdk-plugin-test",
	HOME: "/nonexistent",
};

let dir: string;
let peek: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-sdk-plugin-"));
	peek = storeLocator.open(join(dir, "warden.db"));
});

afterEach(() => {
	peek.close();
	rmSync(dir, { recursive: true, force: true });
});

function options(extra: Partial<WardenClientOptions> = {}): WardenClientOptions {
	return { home: dir, host: { env: { ...ENV, WARDEN_HOME: dir }, cwd: dir }, ...extra };
}

const noop = (): never => {
	throw new Error("not used");
};

function plugin(extra: Partial<ProviderPlugin> = {}): ProviderPlugin {
	return { apiVersion: 1, name: "farm", platform: "android", setup: noop, ...extra };
}

function failureOf(run: () => unknown): { code: string } {
	try {
		run();
	} catch (error) {
		if (isWardenError(error)) return error;
		throw error;
	}
	throw new Error("expected a WardenError");
}

describe("defineProvider", () => {
	test("returns a valid plugin untouched", () => {
		const p = plugin();
		expect(defineProvider(p)).toBe(p);
	});

	test("rejects an unknown apiVersion with config_invalid", () => {
		const bad = { ...plugin(), apiVersion: 2 } as unknown as ProviderPlugin;
		expect(failureOf(() => defineProvider(bad)).code).toBe("config_invalid");
	});

	test.each(["ios", "android", "cloud"])("reserves the name %s (duplicate_provider)", (name) => {
		expect(failureOf(() => defineProvider(plugin({ name }))).code).toBe("duplicate_provider");
	});

	test("rejects a malformed name with usage", () => {
		expect(failureOf(() => defineProvider(plugin({ name: "Bad Name" }))).code).toBe("usage");
	});
});

describe("registration", () => {
	test("two plugins with one name fail createWardenClient with duplicate_provider", () => {
		const failure = failureOf(() => createWardenClient(options({ providers: [plugin(), plugin()] })));
		expect(failure.code).toBe("duplicate_provider");
	});

	test("an unknown provider name on claim is not_found", async () => {
		await using warden = createWardenClient(options({ providers: [fakeFarm()] }));
		const failed = await warden.leases.claim({ platform: "android", provider: "nope" }).catch((e: unknown) => e);
		expect(isWardenError(failed) && failed.code).toBe("not_found");
	});

	test("a provider serving another platform than the claim is usage", async () => {
		await using warden = createWardenClient(options({ providers: [fakeFarm()] }));
		const failed = await warden.leases.claim({ platform: "ios", provider: "fake-farm" }).catch((e: unknown) => e);
		expect(isWardenError(failed) && failed.code).toBe("usage");
	});
});

driverConformance.run("example fake-provider driver", async () => fakeFarmDriver("farm-1"), { appId: "com.farm.app" });

describe("claim → open → snapshot through a plugin", () => {
	test("routes the claim through the plugin's provider and opens its driver", async () => {
		const farm = fakeFarm();
		const events: WardenEvent[] = [];
		let leaseId = "";
		{
			await using warden = createWardenClient(options({ providers: [farm], onEvent: (e) => events.push(e) }));
			const [lease] = await warden.leases.claim({ platform: "android", provider: "fake-farm" });
			expect(lease?.resource).toMatchObject({ kind: "device", platform: "android" });
			const id = lease?.resource.kind === "device" ? lease.resource.id : "";
			expect(id).toMatch(/^farm-/);
			leaseId = lease?.id ?? "";
			expect(peek.getLease(leaseId)).toBeDefined();

			await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });
			const snap = await session.capture.snapshot({ interactiveOnly: true });
			expect(snap.platform).toBe("android");
			expect(snap.elements.some((e) => e.identifier === "start")).toBe(true);
		}
		expect(peek.getLease(leaseId)).toBeUndefined();
		expect(farm.disposed()).toBe(true);
		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain("lease:claimed");
		expect(kinds).toContain("session:opened");
		expect(kinds).toContain("session:closed");
		expect(kinds).toContain("lease:released");
	});

	test("a plugin without driver() fails sessions.open with engine_unavailable", async () => {
		const base = fakeFarm();
		const driverless: ProviderPlugin = defineProvider({
			apiVersion: 1,
			name: "no-driver",
			platform: "android",
			setup: async (ctx) => {
				const { driver: _unused, ...provider } = await base.setup(ctx);
				return provider;
			},
		});
		await using warden = createWardenClient(options({ providers: [driverless] }));
		const [lease] = await warden.leases.claim({ platform: "android", provider: "no-driver" });
		const failed = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> }).catch((e: unknown) => e);
		expect(isWardenError(failed) && failed.code).toBe("engine_unavailable");
	});
});

describe("typed events", () => {
	test("on(kind) receives only that kind, narrowed; the unsubscribe stops it", async () => {
		await using warden = createWardenClient(options({ providers: [fakeFarm()] }));
		const claimed: string[] = [];
		const released: string[] = [];
		const stop = warden.on("lease:claimed", (e) => claimed.push(e.lease.id));
		const onReleased = (e: { leaseId: string }) => released.push(e.leaseId);
		warden.on("lease:released", onReleased);
		const [lease] = await warden.leases.claim({ platform: "android", provider: "fake-farm" });
		expect(claimed).toEqual([lease?.id ?? ""]);
		stop();
		warden.off("lease:released", onReleased);
		await warden.leases.release();
		expect(released).toEqual([]);
		const [second] = await warden.leases.claim({ platform: "android", provider: "fake-farm" });
		expect(second).toBeDefined();
		expect(claimed).toHaveLength(1);
	});

	test("a throwing handler does not fail the call, and onEvent still fires", async () => {
		const seen: string[] = [];
		await using warden = createWardenClient(options({ providers: [fakeFarm()], onEvent: (e) => seen.push(e.kind) }));
		warden.on("lease:claimed", () => {
			throw new Error("handler bug");
		});
		const leases = await warden.leases.claim({ platform: "android", provider: "fake-farm" });
		expect(leases).toHaveLength(1);
		expect(seen).toContain("lease:claimed");
	});

	test("action events carry session id, op and outcome", async () => {
		await using warden = createWardenClient(options({ providers: [fakeFarm()] }));
		const actions: string[] = [];
		warden.on("action", (e) => actions.push(`${e.op}:${e.ok}`));
		const [lease] = await warden.leases.claim({ platform: "android", provider: "fake-farm" });
		await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });
		await session.capture.snapshot();
		expect(actions.some((a) => a.endsWith(":true"))).toBe(true);
	});
});
