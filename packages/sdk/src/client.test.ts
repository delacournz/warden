import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverFixtures, FakeDriver } from "@delacour/warden-driver/testing/driver";
import type { DeviceProvider } from "@delacour/warden-providers/provider.types";
import { screenTesting } from "@delacour/warden-screen/testing/screen";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import type { InventoryDevice } from "@delacour/warden-store/types";
import { wardenErrors } from "@delacour/warden-types/error";
import { resultFactory } from "@delacour/warden-types/result";
import { createWardenClient } from "./client";
import type { ClientSeams } from "./core";
import { isWardenError, WardenError } from "./errors";
import type { WardenClientOptions, WardenEvent } from "./sdk.types";

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";

let dir: string;
let peek: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-sdk-"));
	peek = storeLocator.open(join(dir, "warden.db"));
});

afterEach(() => {
	peek.close();
	rmSync(dir, { recursive: true, force: true });
});

type FakeProvider = DeviceProvider & { calls: string[] };

const POOL = 64;

function poolId(i: number): string {
	return i === 0 ? UDID : `0A1B2C3D-4E5F-6A7B-8C9D-${String(i).padStart(12, "0")}`;
}

function fakeProvider(size: number): FakeProvider {
	const calls: string[] = [];
	const devices: InventoryDevice[] = Array.from({ length: size }, (_, i) => ({
		platform: "ios",
		id: poolId(i),
		name: `warden-iphone-17-${i + 1}`,
		state: "booted",
		wardenCreated: false,
		runtime: "iOS-26-5",
	}));
	return {
		platform: "ios",
		calls,
		inventory: async () => resultFactory.ok(devices.map((d) => ({ ...d }))),
		create: async () => wardenErrors.err("failed", "no create in this fake"),
		boot: async (id) => {
			calls.push(`boot ${id}`);
			return resultFactory.ok(undefined);
		},
		waitReady: async (id) => {
			calls.push(`ready ${id}`);
			return resultFactory.ok(undefined);
		},
		shutdown: async (id) => {
			calls.push(`shutdown ${id}`);
			return resultFactory.ok(undefined);
		},
	};
}

const ENV = {
	WARDEN_CAPACITY: "off",
	WARDEN_ARRANGE: "0",
	WARDEN_BACKGROUND: "0",
	WARDEN_SESSION_ID: "sdk-test",
	HOME: "/nonexistent",
};

type Rig = {
	provider: FakeProvider;
	seams: ClientSeams;
	options: WardenClientOptions;
	events: WardenEvent[];
	opened: FakeDriver[];
};

function rig(driver: () => FakeDriver, extra: Partial<WardenClientOptions> = {}, size = 1): Rig {
	const provider = fakeProvider(size);
	const events: WardenEvent[] = [];
	const opened: FakeDriver[] = [];
	return {
		provider,
		events,
		opened,
		seams: {
			providerFor: () => provider,
			stopHelper: async () => undefined,
			openDriver: async () => {
				const d = driver();
				opened.push(d);
				return resultFactory.ok(d);
			},
		},
		options: {
			home: dir,
			host: { env: { ...ENV, WARDEN_HOME: dir }, cwd: dir },
			onEvent: (e) => events.push(e),
			...extra,
		},
	};
}

describe("claim → open → drive → dispose", () => {
	test("snapshot, press by ref, fill by selector, screenshot, then dispose releases the lease", async () => {
		const { driver } = screenTesting.fieldFixture({ selectAll: true });
		const r = rig(() => driver);
		const shot = join(dir, "out", "shot.png");
		mkdirSync(join(dir, "out"), { recursive: true });
		writeFileSync(
			shot,
			new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 5])
		);

		let leaseId = "";
		{
			await using warden = createWardenClient(r.options, r.seams);
			const [lease] = await warden.leases.claim({ platform: "ios" });
			expect(lease?.resource).toMatchObject({ kind: "device", id: UDID });
			leaseId = lease?.id ?? "";
			expect(peek.getLease(leaseId)).toBeDefined();

			await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });
			const snap = await session.capture.snapshot({ interactiveOnly: true });
			const field = snap.elements.find((e) => e.identifier === "field");
			expect(field?.ref).toMatch(/^@e\d+$/);
			expect(snap.generation).toBe(1);
			expect(snap.platform).toBe("ios");

			await session.interactions.press({ ref: field?.ref as `@e${number}` });
			expect(driver.callsOf("tap")).toHaveLength(1);

			await session.interactions.fill({ selector: "id=field", text: "grace" });
			const value = await session.query.get({ selector: "id=field", property: "value" });
			expect(value).toEqual({ property: "value", value: "grace" });

			const png = await session.capture.screenshot({ path: shot });
			expect(png).toMatchObject({ path: shot, width: 3, height: 5 });
			expect(png.bytes.length).toBeGreaterThan(8);
		}
		expect(peek.getLease(leaseId)).toBeUndefined();
		expect(r.events.some((e) => e.kind === "lease:claimed")).toBe(true);
		expect(r.events.some((e) => e.kind === "lease:released")).toBe(true);
		expect(r.events.some((e) => e.kind === "session:opened")).toBe(true);
		expect(r.events.some((e) => e.kind === "action" && e.op === "capture.snapshot" && e.ok)).toBe(true);
	});

	test("a session closes its driver; the lease stays with the client", async () => {
		const d = new FakeDriver({
			screens: [driverFixtures.snapshotOf([driverFixtures.el("button", { id: "go", label: "Go" })])],
		});
		const r = rig(() => d);
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		const session = await warden.sessions.open({ udid: lease?.resource.kind === "device" ? lease.resource.id : "" });
		await session.close();
		expect(d.callsOf("close").length).toBeGreaterThanOrEqual(0);
		expect(peek.getLease(lease?.id ?? "")).toBeDefined();
	});

	test("lease listing, check and heartbeat", async () => {
		const d = new FakeDriver({ screens: [driverFixtures.snapshotOf([])] });
		const r = rig(() => d);
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		expect(await warden.leases.list({ mine: true })).toHaveLength(1);
		const check = await warden.leases.check(lease as NonNullable<typeof lease>);
		expect(check.state).toBe("held");
		const beat = await warden.leases.heartbeat(lease as NonNullable<typeof lease>);
		expect(beat.id).toBe(lease?.id);
		expect((await warden.leases.check("nope")).state).toBe("missing");
	});
});

describe("lock policy", () => {
	function holdByOther(): void {
		for (let i = 0; i < POOL; i++) {
			peek.insertLease(
				{
					resource: { kind: "device", platform: "ios", id: poolId(i), name: `warden-iphone-17-${i + 1}` },
					owner: { kind: "agent", sessionId: "someone-else", cwd: "/x" },
					ttlMs: 3_600_000,
					pid: process.pid,
				},
				Date.now()
			);
		}
	}

	test("reject fails fast with device_busy", async () => {
		holdByOther();
		const r = rig(() => new FakeDriver({ screens: [driverFixtures.snapshotOf([])] }), { lockPolicy: "reject" }, POOL);
		await using warden = createWardenClient(r.options, r.seams);
		const failure = await warden.leases.claim({ platform: "ios" }).catch((e: unknown) => e);
		expect(isWardenError(failure)).toBe(true);
		expect(failure).toMatchObject({ code: "device_busy", retryable: true });
	});

	test("a per-claim lockPolicy overrides the client's", async () => {
		holdByOther();
		const r = rig(() => new FakeDriver({ screens: [driverFixtures.snapshotOf([])] }), { lockPolicy: "wait" }, POOL);
		await using warden = createWardenClient(r.options, r.seams);
		const failure = await warden.leases.claim({ platform: "ios", lockPolicy: "reject" }).catch((e: unknown) => e);
		expect(failure).toMatchObject({ code: "device_busy" });
	});

	test("wait queues until aborted, then claim_aborted", async () => {
		holdByOther();
		const r = rig(() => new FakeDriver({ screens: [driverFixtures.snapshotOf([])] }), { lockPolicy: "wait" }, POOL);
		await using warden = createWardenClient(r.options, r.seams);
		const controller = new AbortController();
		const pending = warden.leases.claim({ platform: "ios" }, { signal: controller.signal }).catch((e: unknown) => e);
		await Bun.sleep(150);
		controller.abort();
		const failure = await pending;
		expect(failure).toMatchObject({ code: "claim_aborted", dispatched: "no" });
		expect(peek.listQueue()).toHaveLength(0);
	});
});

describe("abort", () => {
	test("an already aborted signal throws interrupted before any work", async () => {
		const r = rig(() => new FakeDriver({ screens: [driverFixtures.snapshotOf([])] }));
		await using warden = createWardenClient(r.options, r.seams);
		const controller = new AbortController();
		controller.abort();
		const failure = await warden.leases
			.claim({ platform: "ios" }, { signal: controller.signal })
			.catch((e: unknown) => e);
		expect(failure).toMatchObject({ code: "interrupted", dispatched: "no" });
		expect(peek.listLeases()).toHaveLength(0);
	});

	test("the client's own signal cancels session calls", async () => {
		const d = new FakeDriver({
			screens: [driverFixtures.snapshotOf([driverFixtures.el("button", { id: "go", label: "Go" })])],
		});
		const controller = new AbortController();
		const r = rig(() => d, { signal: controller.signal });
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });
		controller.abort();
		const failure = await session.capture.snapshot().catch((e: unknown) => e);
		expect(failure).toMatchObject({ code: "interrupted" });
	});

	test("aborting during a wait interrupts it", async () => {
		const d = new FakeDriver({
			screens: [driverFixtures.snapshotOf([driverFixtures.el("button", { id: "go", label: "Go" })])],
		});
		const r = rig(() => d);
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });
		const controller = new AbortController();
		const pending = session.query
			.wait({ selector: "id=missing", for: "visible", timeoutMs: 30_000 }, { signal: controller.signal })
			.catch((e: unknown) => e);
		await Bun.sleep(150);
		controller.abort();
		expect(await pending).toMatchObject({ code: "interrupted" });
	});
});

describe("error mapping", () => {
	test("a foreign device is never opened", async () => {
		peek.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: UDID, name: "x" },
				owner: { kind: "agent", sessionId: "someone-else", cwd: "/x" },
				ttlMs: 3_600_000,
				pid: process.pid,
			},
			Date.now()
		);
		const r = rig(() => new FakeDriver({ screens: [driverFixtures.snapshotOf([])] }));
		await using warden = createWardenClient(r.options, r.seams);
		const failure = await warden.sessions.open({ udid: UDID }).catch((e: unknown) => e);
		expect(failure).toMatchObject({ code: "device_foreign", dispatched: "no" });
		expect(r.opened).toHaveLength(0);
	});

	test("a device nobody leased is not opened either", async () => {
		const r = rig(() => new FakeDriver({ screens: [driverFixtures.snapshotOf([])] }));
		await using warden = createWardenClient(r.options, r.seams);
		const failure = await warden.sessions.open({ udid: UDID }).catch((e: unknown) => e);
		expect(failure).toMatchObject({ code: "device_not_leased" });
		expect(failure).toBeInstanceOf(WardenError);
		expect((failure as WardenError).hint).toContain("leases.claim");
	});

	test("an unknown ref is stale_ref with dispatched no", async () => {
		const d = new FakeDriver({
			screens: [driverFixtures.snapshotOf([driverFixtures.el("button", { id: "go", label: "Go" })])],
		});
		const r = rig(() => d);
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });
		await session.capture.snapshot();
		const failure = await session.interactions.press({ ref: "@e99" }).catch((e: unknown) => e);
		expect(failure).toMatchObject({ code: "stale_ref", dispatched: "no", retryable: true });
		expect(d.callsOf("tap")).toHaveLength(0);
	});

	test("a driver failure surfaces as a coded WardenError that serialises", async () => {
		const d = new FakeDriver({
			screens: [driverFixtures.snapshotOf([driverFixtures.el("button", { id: "go", label: "Go" })])],
			onCall: (call) => (call.method === "tap" ? driverFixtures.failWith("E_HELPER_CRASHED", "gone") : undefined),
		});
		const r = rig(() => d);
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });
		const failure = await session.interactions.press({ selector: "id=go" }).catch((e: unknown) => e);
		expect(isWardenError(failure)).toBe(true);
		const json = JSON.parse(JSON.stringify(failure)) as Record<string, unknown>;
		expect(json).toMatchObject({ code: "engine_unavailable", dispatched: "no" });
	});

	test("a missing engine fails sessions.open, not the first call", async () => {
		const r = rig(() => new FakeDriver({ screens: [driverFixtures.snapshotOf([])] }));
		r.seams.openDriver = async () => ({
			success: false,
			error: { code: "engine_unavailable", message: "warden-simd missing" },
		});
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		const failure = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> }).catch((e: unknown) => e);
		expect(failure).toMatchObject({ code: "engine_unavailable", dispatched: "no" });
	});
});

describe("lifecycle", () => {
	test("close is idempotent and releases once", async () => {
		const r = rig(() => new FakeDriver({ screens: [driverFixtures.snapshotOf([])] }));
		const warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		await warden.close();
		await warden.close();
		expect(peek.getLease(lease?.id ?? "")).toBeUndefined();
		expect(r.events.filter((e) => e.kind === "lease:released")).toHaveLength(1);
	});

	test("a device the client booted is shut down on close; a pooled one is left running", async () => {
		const r = rig(() => new FakeDriver({ screens: [driverFixtures.snapshotOf([])] }));
		const warden = createWardenClient(r.options, r.seams);
		await warden.leases.claim({ platform: "ios" });
		await warden.close();
		expect(r.provider.calls.some((c) => c.startsWith("shutdown"))).toBe(false);
	});

	test("release with shutdown follows the shutdown policy", async () => {
		const r = rig(() => new FakeDriver({ screens: [driverFixtures.snapshotOf([])] }));
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		peek.recordDevice({ platform: "ios", id: UDID, name: "warden-iphone-17-1", profile: "iphone-17" }, Date.now());
		const result = await warden.leases.release({ leaseIds: [lease?.id ?? ""], shutdown: true });
		expect(result.released).toEqual([lease?.id ?? ""]);
		expect(result.shutdown).toEqual([UDID]);
		expect(existsSync(dir)).toBe(true);
	});

	test("releasing a lease someone else holds is lease_foreign", async () => {
		const other = peek.insertLease(
			{
				resource: { kind: "port", port: 9999 },
				owner: { kind: "agent", sessionId: "someone-else", cwd: "/x" },
				ttlMs: 60_000,
			},
			Date.now()
		);
		const r = rig(() => new FakeDriver({ screens: [driverFixtures.snapshotOf([])] }));
		await using warden = createWardenClient(r.options, r.seams);
		const failure = await warden.leases.release({ leaseIds: [other.id] }).catch((e: unknown) => e);
		expect(failure).toMatchObject({ code: "lease_foreign" });
	});

	test("the client heartbeats the leases it holds", async () => {
		const r = rig(() => new FakeDriver({ screens: [driverFixtures.snapshotOf([])] }));
		let clock = Date.now();
		r.options.host = { ...r.options.host, now: () => clock };
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		const claimedAt = peek.getLease(lease?.id ?? "")?.heartbeatAt ?? 0;
		clock += 60_000;
		await warden.leases.heartbeat(lease as NonNullable<typeof lease>);
		expect(peek.getLease(lease?.id ?? "")?.heartbeatAt ?? 0).toBeGreaterThan(claimedAt);
	});

	test("ports claim and release", async () => {
		const r = rig(() => new FakeDriver({ screens: [driverFixtures.snapshotOf([])] }));
		await using warden = createWardenClient(r.options, r.seams);
		const port = await warden.ports.claim({ spec: "47100:20" });
		expect(port.resource.kind).toBe("port");
		await warden.ports.release(port);
		expect(peek.getLease(port.id)).toBeUndefined();
	});

	test("devices list reads the provider and marks leases", async () => {
		const r = rig(() => new FakeDriver({ screens: [driverFixtures.snapshotOf([])] }));
		await using warden = createWardenClient(r.options, r.seams);
		await warden.leases.claim({ platform: "ios" });
		const devices = await warden.devices.list({ platform: "ios" });
		expect(devices).toHaveLength(1);
		expect(devices[0]).toMatchObject({ id: UDID, leased: true, state: "booted" });
	});
});

describe("store compatibility", () => {
	test("a store written by a newer warden fails with store_incompatible and the update hint", async () => {
		peek.db.exec("PRAGMA user_version = 999");
		await using warden = createWardenClient({ home: dir, host: { env: { ...ENV, WARDEN_HOME: dir }, cwd: dir } });
		const failure = await warden.leases.list().then(
			() => undefined,
			(error: unknown) => error
		);
		expect(isWardenError(failure)).toBe(true);
		if (!isWardenError(failure)) return;
		expect(failure.code).toBe("store_incompatible");
		expect(failure.hint).toContain("warden update");
		expect(failure.dispatched).toBe("no");
	});

	test("the current schema opens", async () => {
		await using warden = createWardenClient({ home: dir, host: { env: { ...ENV, WARDEN_HOME: dir }, cwd: dir } });
		expect(await warden.leases.list()).toEqual([]);
	});
});
