import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { type ClaimInput, claimDevices, PENDING_PREFIX, QUARANTINE_TTL_MS } from "./claim";
import type { Exec, ExecResult } from "./exec";
import { createIosProvider } from "./providers/ios";
import { simctlDevicesJson } from "./providers/ios.fixture";
import type { BootReady, DeviceProvider } from "./providers/provider.types";
import { openStore, type Store } from "./store";
import type { DeviceRequest, InventoryDevice, Owner } from "./types";

let dir: string;
let store: Store;
const NOW = 1_000_000;
const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/w" };
const other: Owner = { kind: "agent", sessionId: "s2", cwd: "/x" };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-claim-"));
	store = openStore(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function sim(id: string, overrides: Partial<InventoryDevice> = {}): InventoryDevice {
	return {
		platform: "ios",
		id,
		name: `warden-iphone-17-${id}`,
		state: "shutdown",
		wardenCreated: false,
		runtime: "iOS-26-5",
		...overrides,
	};
}

type FakeProvider = DeviceProvider & { devices: InventoryDevice[]; calls: string[] };

function fakeProvider(devices: InventoryDevice[], failures: { boot?: string; create?: string } = {}): FakeProvider {
	const calls: string[] = [];
	let created = 0;
	const p: FakeProvider = {
		platform: "ios",
		devices,
		calls,
		inventory: async () => ok(p.devices.map((d) => ({ ...d }))),
		async create(name, profile, runtime): AsyncResult<InventoryDevice> {
			calls.push(`create ${name} ${profile} ${runtime ?? "-"}`);
			if (failures.create) return err(failures.create);
			created++;
			const device: InventoryDevice = {
				platform: "ios",
				id: `NEW${created}`,
				name,
				state: "shutdown",
				wardenCreated: true,
				profile,
				runtime: "iOS-26-5",
			};
			p.devices.push(device);
			store.recordDevice({ platform: "ios", id: device.id, name, profile }, NOW);
			return ok(device);
		},
		async boot(id) {
			calls.push(`boot ${id}`);
			if (failures.boot === id) return err(`boot ${id} failed`);
			const d = p.devices.find((x) => x.id === id);
			if (d) d.state = "booted";
			return ok(undefined);
		},
		async waitReady(id) {
			calls.push(`ready ${id}`);
			return ok(undefined);
		},
		async shutdown(id) {
			calls.push(`shutdown ${id}`);
			return ok(undefined);
		},
	};
	return p;
}

function request(overrides: Partial<DeviceRequest> = {}): DeviceRequest {
	return { platform: "ios", profile: "iphone-17", count: 1, max: 2, ...overrides };
}

function input(provider: DeviceProvider, overrides: Partial<ClaimInput> = {}): ClaimInput {
	return {
		store,
		provider,
		owner,
		request: request(),
		ttlMs: 60_000,
		now: () => NOW,
		pidAlive: () => false,
		waitMs: 0,
		sleep: async () => {},
		...overrides,
	};
}

describe("claimDevices", () => {
	test("reuses a booted free warden device without booting", async () => {
		const provider = fakeProvider([sim("1", { state: "booted" })]);
		const result = await claimDevices(input(provider, { label: "e2e" }));
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.claimed).toHaveLength(1);
		const [c] = result.data.claimed;
		expect(c?.action).toBe("reuse");
		expect(c?.device.id).toBe("1");
		expect(c?.lease.label).toBe("e2e");
		expect(provider.calls).toEqual(["ready 1"]);
		expect(store.listLeases().map((l) => l.id)).toEqual([c?.lease.id ?? ""]);
		expect(store.listLeases()[0]?.bootedByOwner).toBeUndefined();
	});

	test("boots a shutdown warden device", async () => {
		const provider = fakeProvider([sim("1")]);
		const result = await claimDevices(input(provider));
		expect(result.success && result.data.claimed[0]?.action).toBe("boot");
		expect(provider.calls).toEqual(["boot 1", "ready 1"]);
		expect(result.success && result.data.claimed[0]?.device.state).toBe("booted");
		expect(store.listLeases()[0]?.bootedByOwner).toBe(true);
		expect(result.success && result.data.claimed[0]?.lease.bootedByOwner).toBe(true);
	});

	test("boots every claimed device at once, not one by one", async () => {
		const provider = fakeProvider([sim("1"), sim("2"), sim("3")]);
		let inFlight = 0;
		let peak = 0;
		const boot = provider.boot;
		provider.boot = async (id) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await Bun.sleep(5);
			inFlight--;
			return boot(id);
		};
		const result = await claimDevices(input(provider, { request: request({ count: 3, max: 3 }) }));
		expect(result.success).toBe(true);
		expect(peak).toBe(3);
	});

	test("creates when pool has room; lease is on the real udid, not the placeholder", async () => {
		const provider = fakeProvider([]);
		const result = await claimDevices(input(provider, { request: request({ runtime: "latest" }) }));
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.claimed[0]?.action).toBe("create");
		expect(provider.calls).toEqual(["create warden-iphone-17-1 iphone-17 latest", "boot NEW1", "ready NEW1"]);
		const leases = store.listLeases();
		expect(leases).toHaveLength(1);
		expect(leases[0]?.resource).toEqual({ kind: "device", platform: "ios", id: "NEW1", name: "warden-iphone-17-1" });
		expect(leases[0]?.bootedByOwner).toBe(true);
	});

	test("never hands out a device leased by someone else", async () => {
		const provider = fakeProvider([sim("1", { state: "booted" }), sim("2", { state: "booted" })]);
		const first = await claimDevices(input(provider, { owner: other }));
		const second = await claimDevices(input(provider));
		expect(first.success && second.success).toBe(true);
		if (!first.success || !second.success) return;
		expect(first.data.claimed[0]?.device.id).not.toBe(second.data.claimed[0]?.device.id);
	});

	test("foreign devices are skipped unless adopt", async () => {
		const foreign = sim("F", { name: "iPhone 17", profile: "iphone-17", state: "booted" });
		const provider = fakeProvider([foreign]);
		const noAdopt = await claimDevices(input(provider, { request: request({ max: 0 }) }));
		expect(noAdopt.success).toBe(false);
		const adopt = await claimDevices(input(provider, { request: request({ max: 0, adopt: true }) }));
		expect(adopt.success && adopt.data.claimed[0]?.device.id).toBe("F");
	});

	test("pool full + no wait → clear err", async () => {
		const provider = fakeProvider([sim("1", { state: "booted" }), sim("2", { state: "booted" })]);
		await claimDevices(input(provider, { owner: other, request: request({ count: 2 }) }));
		const result = await claimDevices(input(provider));
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBe("all 2 warden-iphone-17 devices leased; max 2 — use --wait or --max");
		}
	});

	test("waits (polling) until a lease is released", async () => {
		const provider = fakeProvider([sim("1", { state: "booted" })]);
		const held = await claimDevices(input(provider, { owner: other, request: request({ max: 1 }) }));
		expect(held.success).toBe(true);
		let clock = NOW;
		const sleeps: number[] = [];
		const result = await claimDevices(
			input(provider, {
				request: request({ max: 1 }),
				now: () => clock,
				waitMs: 10_000,
				pollMs: 1_000,
				sleep: async (ms) => {
					sleeps.push(ms);
					clock += ms;
					if (sleeps.length === 3 && held.success) store.deleteLeases(held.data.claimed.map((c) => c.lease.id));
				},
			})
		);
		expect(result.success).toBe(true);
		expect(sleeps).toEqual([1_000, 1_000, 1_000]);
	});

	test("wait gives up after waitMs", async () => {
		const provider = fakeProvider([sim("1", { state: "booted" })]);
		await claimDevices(input(provider, { owner: other, request: request({ max: 1 }) }));
		let clock = NOW;
		const result = await claimDevices(
			input(provider, {
				request: request({ max: 1 }),
				now: () => clock,
				waitMs: 3_000,
				pollMs: 1_000,
				sleep: async (ms) => {
					clock += ms;
				},
			})
		);
		expect(result.success).toBe(false);
		expect(clock).toBe(NOW + 3_000);
	});

	test("stale leases are reclaimed", async () => {
		const provider = fakeProvider([sim("1", { state: "booted" })]);
		store.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "1", name: "warden-iphone-17-1" }, owner: other, ttlMs: 1 },
			0
		);
		const result = await claimDevices(input(provider, { request: request({ max: 1 }) }));
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.reclaimed).toHaveLength(1);
	});

	test("boot failure → all leases from this claim released, err returned", async () => {
		const provider = fakeProvider([sim("1"), sim("2")], { boot: "2" });
		const result = await claimDevices(input(provider, { request: request({ count: 2 }) }));
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("boot 2 failed");
		expect(store.listLeases()).toEqual([]);
	});

	test("create failure → placeholder removed", async () => {
		const provider = fakeProvider([], { create: "no runtime" });
		const result = await claimDevices(input(provider));
		expect(result.success).toBe(false);
		expect(store.listLeases()).toEqual([]);
	});

	test("in-flight create (placeholder) blocks the name and counts toward max", async () => {
		const provider = fakeProvider([sim("1", { state: "booted" })]);
		store.insertLease(
			{
				resource: {
					kind: "device",
					platform: "ios",
					id: `${PENDING_PREFIX}warden-iphone-17-2`,
					name: "warden-iphone-17-2",
				},
				owner: other,
				ttlMs: 60_000,
			},
			NOW
		);
		provider.devices.push(sim("2", { name: "warden-iphone-17-2" }));
		const held = await claimDevices(input(provider, { owner: other }));
		expect(held.success && held.data.claimed[0]?.device.id).toBe("1");
		const result = await claimDevices(input(provider));
		expect(result.success).toBe(false);
		expect(provider.calls.filter((c) => c.startsWith("create"))).toEqual([]);
	});

	test("touches devices on success and sets lease pid", async () => {
		const provider = fakeProvider([sim("1", { state: "booted" })]);
		store.recordDevice({ platform: "ios", id: "1", name: "warden-iphone-17-1", profile: "iphone-17" }, 5);
		const result = await claimDevices(input(provider, { pid: 4242 }));
		expect(result.success && result.data.claimed[0]?.lease.pid).toBe(4242);
		expect(store.listDevices("ios")[0]?.lastUsedAt).toBe(NOW);
	});

	test("heartbeat refreshed once devices are ready (boot can be slow)", async () => {
		let clock = NOW;
		const provider = fakeProvider([sim("1")]);
		const boot = provider.boot.bind(provider);
		provider.boot = async (id) => {
			clock += 120_000;
			return boot(id);
		};
		const result = await claimDevices(input(provider, { now: () => clock }));
		expect(result.success && result.data.claimed[0]?.lease.heartbeatAt).toBe(NOW + 120_000);
		expect(store.listLeases()[0]?.heartbeatAt).toBe(NOW + 120_000);
	});

	test("inventory failure → err", async () => {
		const provider = fakeProvider([]);
		provider.inventory = async () => err("simctl missing");
		const result = await claimDevices(input(provider));
		expect(result).toEqual({ success: false, error: "simctl missing" });
	});
});

describe("claim health probe", () => {
	function withProbe(provider: FakeProvider, bad: Set<string>): FakeProvider {
		provider.probe = async (id) => {
			provider.calls.push(`probe ${id}`);
			return bad.has(id) ? err(`${id}: hung`) : ok(undefined);
		};
		return provider;
	}

	test("quarantines an unhealthy warden device, releases its lease and claims another", async () => {
		const provider = withProbe(fakeProvider([sim("1", { state: "booted" }), sim("2")]), new Set(["1"]));
		const logs: string[] = [];
		const result = await claimDevices(input(provider, { log: (l) => logs.push(l) }));
		expect(result.success && result.data.claimed.map((c) => c.device.id)).toEqual(["2"]);
		expect(store.listDevices().find((d) => d.id === "1")).toMatchObject({ quarantineReason: "claim: 1: hung" });
		expect(store.listLeases().map((l) => l.resource.kind === "device" && l.resource.id)).toEqual(["2"]);
		expect(logs.join("\n")).toContain("quarantined");
	});

	test("a quarantined device is not offered to the next claim", async () => {
		const provider = withProbe(fakeProvider([sim("1", { state: "booted" })]), new Set(["1"]));
		const result = await claimDevices(input(provider, { request: request({ max: 1 }) }));
		expect(result.success && result.data.claimed[0]?.action).toBe("create");
		expect(result.success && result.data.claimed[0]?.device.id).toBe("NEW1");
	});

	test("foreign unhealthy device is skipped, never quarantined or shut down", async () => {
		const provider = withProbe(
			fakeProvider([
				sim("F", { name: "Chris iPhone", wardenCreated: false, profile: "iphone-17", state: "booted" }),
				sim("2", { state: "booted" }),
			]),
			new Set(["F"])
		);
		const result = await claimDevices(input(provider, { request: request({ adopt: true }) }));
		expect(result.success && result.data.claimed[0]?.device.id).toBe("2");
		expect(store.listDevices().find((d) => d.id === "F")).toBeUndefined();
		expect(provider.calls).not.toContain("shutdown F");
	});

	test("gives up with a clear error after bounded retries and leaves no leases", async () => {
		const provider = withProbe(
			fakeProvider([sim("1", { state: "booted" })]),
			new Set(["1", "NEW1", "NEW2", "NEW3", "NEW4"])
		);
		const result = await claimDevices(input(provider, { request: request({ max: 9 }) }));
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("failed the health probe");
		expect(store.listLeases()).toEqual([]);
		expect(provider.calls.filter((c) => c.startsWith("probe")).length).toBe(3);
	});

	test("healthy devices are unaffected", async () => {
		const provider = withProbe(fakeProvider([sim("1", { state: "booted" })]), new Set());
		const result = await claimDevices(input(provider));
		expect(result.success && result.data.claimed[0]?.device.id).toBe("1");
		expect(store.listDevices()).toEqual([]);
	});
});

describe("claim readiness timeout (16-2)", () => {
	function stuck(provider: FakeProvider, bad: Set<string>): FakeProvider {
		provider.waitReady = async (id, timeoutMs) => {
			provider.calls.push(`ready ${id}`);
			return bad.has(id) ? err(`${id} not ready within ${timeoutMs / 1000}s: bootstatus timed out`) : ok(undefined);
		};
		return provider;
	}

	test("a warden device that never gets ready is quarantined, shut down, and another one claimed", async () => {
		const provider = stuck(fakeProvider([sim("1", { state: "booted" }), sim("2")]), new Set(["1"]));
		const logs: string[] = [];
		const result = await claimDevices(input(provider, { readyTimeoutMs: 300_000, log: (l) => logs.push(l) }));
		expect(result.success && result.data.claimed.map((c) => c.device.id)).toEqual(["2"]);
		expect(store.listDevices().find((d) => d.id === "1")?.quarantineReason).toContain("not ready within 300s");
		expect(provider.calls).toContain("shutdown 1");
		expect(store.listLeases().map((l) => l.resource.kind === "device" && l.resource.id)).toEqual(["2"]);
		expect(logs.join("\n")).toContain("quarantined");
	});

	test("the stuck device is not offered to the next claim", async () => {
		const provider = stuck(fakeProvider([sim("1", { state: "booted" })]), new Set(["1"]));
		const first = await claimDevices(input(provider, { request: request({ max: 1 }) }));
		expect(first.success && first.data.claimed[0]?.device.id).toBe("NEW1");
		provider.calls.length = 0;
		const second = await claimDevices(input(provider, { owner: other, request: request({ max: 1 }) }));
		expect(second.success).toBe(false);
		expect(provider.calls).not.toContain("ready 1");
	});

	test("a foreign device that never gets ready is skipped, not quarantined or shut down", async () => {
		const provider = stuck(
			fakeProvider([
				sim("F", { name: "Chris iPhone", wardenCreated: false, profile: "iphone-17", state: "booted" }),
				sim("2", { state: "booted" }),
			]),
			new Set(["F"])
		);
		const result = await claimDevices(input(provider, { request: request({ adopt: true }) }));
		expect(result.success && result.data.claimed[0]?.device.id).toBe("2");
		expect(store.listDevices().find((d) => d.id === "F")).toBeUndefined();
		expect(provider.calls).not.toContain("shutdown F");
	});
});

describe("claim warm path", () => {
	function withWarm(provider: FakeProvider, ok_: boolean): FakeProvider {
		provider.probe = async (id) => {
			provider.calls.push(`probe ${id}`);
			return ok(undefined);
		};
		provider.verifyWarm = async (id) => {
			provider.calls.push(`warm ${id}`);
			return ok_ ? ok(undefined) : err(`${id}: SpringBoard is not running`);
		};
		return provider;
	}

	test("an already-booted device passes the cheap check: no waitReady, no full probe", async () => {
		const provider = withWarm(fakeProvider([sim("1", { state: "booted" })]), true);
		const result = await claimDevices(input(provider));
		expect(result.success && result.data.claimed[0]?.action).toBe("reuse");
		expect(result.success && result.data.claimed[0]?.device.state).toBe("booted");
		expect(provider.calls).toEqual(["warm 1"]);
		expect(store.listLeases()[0]?.bootedByOwner).toBeUndefined();
	});

	test("a failed cheap check falls back to waitReady + the full probe", async () => {
		const provider = withWarm(fakeProvider([sim("1", { state: "booted" })]), false);
		const result = await claimDevices(input(provider));
		expect(result.success).toBe(true);
		expect(provider.calls).toEqual(["warm 1", "ready 1", "probe 1"]);
	});

	test("a device this claim boots still waits and probes in full", async () => {
		const provider = withWarm(fakeProvider([sim("1")]), true);
		const result = await claimDevices(input(provider));
		expect(result.success && result.data.claimed[0]?.action).toBe("boot");
		expect(provider.calls).toEqual(["boot 1", "ready 1", "probe 1"]);
	});

	test("a new device waits and probes in full", async () => {
		const provider = withWarm(fakeProvider([]), true);
		const result = await claimDevices(input(provider));
		expect(result.success && result.data.claimed[0]?.action).toBe("create");
		expect(provider.calls).toEqual(["create warden-iphone-17-1 iphone-17 -", "boot NEW1", "ready NEW1", "probe NEW1"]);
	});
});

describe("claim spawn counts (iOS provider)", () => {
	const LAUNCHCTL_LIST = "PID\tStatus\tLabel\n412\t0\tUIKitApplication:com.apple.springboard[ab][rb-legacy]";

	/** A fake simctl with one warden sim in `state`; every spawn is recorded. */
	function world(state: "Booted" | "Shutdown" | "Shutting Down", springboard = true) {
		const spawns: string[] = [];
		let statuses = 0;
		const exec: Exec = async (cmd): Promise<ExecResult> => {
			const joined = cmd.join(" ");
			spawns.push(joined);
			const ok_ = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
			if (joined === "xcrun simctl bootstatus U1 -b" && state === "Shutting Down" && ++statuses === 1) {
				return { exitCode: 149, stdout: "", stderr: "Unable to boot device in current state: Shutting Down" };
			}
			if (joined === "xcrun simctl list devices available -j") {
				return ok_(simctlDevicesJson({ "iOS-26-5": [{ udid: "U1", name: "warden-iphone-17-1", state }] }));
			}
			if (joined === "xcrun simctl spawn U1 launchctl list") {
				return ok_(springboard ? LAUNCHCTL_LIST : "PID\tStatus\tLabel");
			}
			return ok_();
		};
		const provider = createIosProvider({ exec, store, env: {}, now: () => NOW, owner });
		return { spawns, provider };
	}

	test("a warm claim of an already-booted sim is two spawns: simctl list and launchctl list", async () => {
		const { spawns, provider } = world("Booted");
		const result = await claimDevices(input(provider));
		expect(result.success && result.data.claimed[0]?.action).toBe("reuse");
		expect(spawns).toEqual(["xcrun simctl list devices available -j", "xcrun simctl spawn U1 launchctl list"]);
	});

	test("a sim this claim boots: bootstatus -b alone boots it, then the one-spawn probe (16-15)", async () => {
		const { spawns, provider } = world("Shutdown");
		const result = await claimDevices(input(provider));
		expect(result.success && result.data.claimed[0]?.action).toBe("boot");
		expect(spawns).toEqual([
			"xcrun simctl list devices available -j",
			"xcrun simctl bootstatus U1 -b",
			"xcrun simctl spawn U1 launchctl list",
		]);
		expect(store.listLeases()[0]?.bootedByOwner).toBe(true);
	});

	test("a sim still Shutting Down is never a reuse step: bootstatus refuses it, simctl boot waits it out (16-1, 16-15)", async () => {
		const { spawns, provider } = world("Shutting Down");
		const result = await claimDevices(input(provider));
		expect(result.success && result.data.claimed[0]?.action).toBe("boot");
		expect(spawns).toEqual([
			"xcrun simctl list devices available -j",
			"xcrun simctl bootstatus U1 -b",
			"xcrun simctl boot U1",
			"xcrun simctl bootstatus U1 -b",
			"xcrun simctl spawn U1 launchctl list",
		]);
		expect(store.listLeases()[0]?.bootedByOwner).toBe(true);
	});

	test("a booted sim whose SpringBoard is not up yet still gets bootstatus before the full probe", async () => {
		const { spawns, provider } = world("Booted", false);
		await claimDevices(input(provider));
		expect(spawns.slice(0, 3)).toEqual([
			"xcrun simctl list devices available -j",
			"xcrun simctl spawn U1 launchctl list",
			"xcrun simctl bootstatus U1 -b",
		]);
	});
});

describe("claim bootReady path (16-15)", () => {
	function withBootReady(provider: FakeProvider, outcome: (id: string) => BootReady): FakeProvider {
		provider.bootReady = async (id) => {
			provider.calls.push(`bootReady ${id}`);
			return outcome(id);
		};
		provider.probe = async (id) => {
			provider.calls.push(`probe ${id}`);
			return ok(undefined);
		};
		provider.probeBooted = async (id) => {
			provider.calls.push(`probeBooted ${id}`);
			return ok(undefined);
		};
		return provider;
	}

	test("a device this claim boots: one bootReady and the post-boot probe, no boot/waitReady/full probe", async () => {
		const provider = withBootReady(fakeProvider([sim("1")]), () => ({ kind: "ready" }));
		const result = await claimDevices(input(provider));
		expect(result.success && result.data.claimed[0]?.action).toBe("boot");
		expect(provider.calls).toEqual(["bootReady 1", "probeBooted 1"]);
		expect(store.listLeases()[0]?.bootedByOwner).toBe(true);
		expect(result.success && result.data.claimed[0]?.device.state).toBe("booted");
	});

	test("a reused booted device is untouched by bootReady", async () => {
		const provider = withBootReady(fakeProvider([sim("1", { state: "booted" })]), () => ({ kind: "ready" }));
		await claimDevices(input(provider));
		expect(provider.calls).toEqual(["ready 1", "probe 1"]);
	});

	test("boot-failed is a plain claim error: leases released, nothing quarantined", async () => {
		const provider = withBootReady(fakeProvider([sim("1")]), (id) => ({
			kind: "boot-failed",
			error: `${id}: Invalid device`,
		}));
		const result = await claimDevices(input(provider));
		expect(result).toEqual({ success: false, error: "1: Invalid device" });
		expect(store.listLeases()).toEqual([]);
		expect(store.listDevices()).toEqual([]);
	});

	test("not-ready is unhealthy: quarantined and another device claimed", async () => {
		const provider = withBootReady(fakeProvider([sim("1"), sim("2")]), (id) =>
			id === "1" ? { kind: "not-ready", error: "1 not ready within 300s: timed out" } : { kind: "ready" }
		);
		const result = await claimDevices(input(provider, { readyTimeoutMs: 300_000 }));
		expect(result.success && result.data.claimed.map((c) => c.device.id)).toEqual(["2"]);
		expect(store.listDevices().find((d) => d.id === "1")?.quarantineReason).toContain("not ready within 300s");
	});
});

describe("claim probe under host load (16-10)", () => {
	const TIMEOUT = (id: string) => `${id}: launchctl print system did not answer within 15s`;

	function probing(provider: FakeProvider, answers: Record<string, string[]>): FakeProvider {
		provider.probe = async (id) => {
			provider.calls.push(`probe ${id}`);
			const next = answers[id]?.shift();
			return next === undefined || next === "ok" ? ok(undefined) : err(next);
		};
		return provider;
	}
	const overloaded = () => ({ load1: 30, cores: 8 });
	const idle = () => ({ load1: 2, cores: 8 });

	test("a probe timeout on an overloaded host is re-probed once after 5 s; a healthy answer keeps the device", async () => {
		const provider = probing(fakeProvider([sim("1", { state: "booted" })]), { "1": [TIMEOUT("1"), "ok"] });
		const slept: number[] = [];
		const result = await claimDevices(input(provider, { load: overloaded, sleep: async (ms) => void slept.push(ms) }));
		expect(result.success && result.data.claimed[0]?.device.id).toBe("1");
		expect(provider.calls).toEqual(["ready 1", "probe 1", "probe 1"]);
		expect(slept).toEqual([5_000]);
		expect(store.listDevices()).toEqual([]);
	});

	test("a second timeout on an overloaded host skips the device this round: not quarantined, not shut down", async () => {
		const provider = probing(fakeProvider([sim("1", { state: "booted" }), sim("2")]), {
			"1": [TIMEOUT("1"), TIMEOUT("1")],
		});
		const logs: string[] = [];
		const result = await claimDevices(input(provider, { load: overloaded, log: (l) => logs.push(l) }));
		expect(result.success && result.data.claimed.map((c) => c.device.id)).toEqual(["2"]);
		expect(store.listDevices().find((d) => d.id === "1")?.quarantinedAt).toBeUndefined();
		expect(provider.calls).not.toContain("shutdown 1");
		expect(logs.join("\n")).toContain("host overloaded");
	});

	test("a probe timeout on an idle host still quarantines (a hung sim, not a busy host)", async () => {
		const provider = probing(fakeProvider([sim("1", { state: "booted" }), sim("2")]), { "1": [TIMEOUT("1")] });
		const result = await claimDevices(input(provider, { load: idle }));
		expect(result.success && result.data.claimed.map((c) => c.device.id)).toEqual(["2"]);
		expect(store.listDevices().find((d) => d.id === "1")?.quarantinedAt).toBe(NOW);
		expect(provider.calls.filter((c) => c === "probe 1")).toHaveLength(1);
	});

	test("SpringBoard not running quarantines even on an overloaded host, with no re-probe", async () => {
		const provider = probing(fakeProvider([sim("1", { state: "booted" }), sim("2")]), {
			"1": ["1: SpringBoard is not running"],
		});
		await claimDevices(input(provider, { load: overloaded }));
		expect(store.listDevices().find((d) => d.id === "1")?.quarantinedAt).toBe(NOW);
		expect(provider.calls.filter((c) => c === "probe 1")).toHaveLength(1);
	});
});

describe("claim quarantine expiry (16-10)", () => {
	function quarantined(id: string, reason: string, at: number) {
		store.recordDevice({ platform: "ios", id, name: `warden-iphone-17-${id}`, profile: "iphone-17" }, at);
		store.quarantineDevice({ platform: "ios", id, name: `warden-iphone-17-${id}`, profile: "iphone-17" }, reason, at);
	}

	test("a claim quarantine older than 24 h is lifted: the device is offered again and the record cleared", async () => {
		quarantined("1", "claim: 1: launchctl list did not answer within 15s", NOW - QUARANTINE_TTL_MS);
		const provider = fakeProvider([sim("1", { profile: "iphone-17" })]);
		const logs: string[] = [];
		const result = await claimDevices(input(provider, { request: request({ max: 1 }), log: (l) => logs.push(l) }));
		expect(result.success && result.data.claimed[0]?.device.id).toBe("1");
		expect(store.listDevices().find((d) => d.id === "1")?.quarantinedAt).toBeUndefined();
		expect(logs.join("\n")).toContain("quarantine expired");
		expect(QUARANTINE_TTL_MS).toBe(24 * 60 * 60_000);
	});

	test("a younger claim quarantine still holds", async () => {
		quarantined("1", "claim: 1: hung", NOW - QUARANTINE_TTL_MS + 1);
		const provider = fakeProvider([sim("1", { profile: "iphone-17" })]);
		const result = await claimDevices(input(provider, { request: request({ max: 1 }) }));
		expect(result.success && result.data.claimed[0]?.device.id).toBe("NEW1");
		expect(store.listDevices().find((d) => d.id === "1")?.quarantinedAt).toBe(NOW - QUARANTINE_TTL_MS + 1);
	});

	test("a quarantine a person set (release --bad) never expires", async () => {
		quarantined("1", "flaky keyboard", NOW - 7 * QUARANTINE_TTL_MS);
		const provider = fakeProvider([sim("1", { profile: "iphone-17" })]);
		const result = await claimDevices(input(provider, { request: request({ max: 1 }) }));
		expect(result.success && result.data.claimed[0]?.device.id).toBe("NEW1");
		expect(store.listDevices().find((d) => d.id === "1")?.quarantineReason).toBe("flaky keyboard");
	});
});

describe("claim under host load: pool of one (ios-claim-path-R1, R2)", () => {
	const TIMEOUT = (id: string) => `${id}: launchctl list did not answer within 15s`;
	const overloaded = () => ({ load1: 30, cores: 8 });

	function poolOfOne(answers: string[]): FakeProvider {
		const device = sim("1", { wardenCreated: true, profile: "iphone-17" });
		store.recordDevice({ platform: "ios", id: "1", name: device.name, profile: "iphone-17" }, NOW);
		const provider = fakeProvider([device]);
		provider.bootReady = async (id) => {
			provider.calls.push(`bootReady ${id}`);
			return { kind: "ready" };
		};
		provider.probeBooted = async (id) => {
			provider.calls.push(`probe ${id}`);
			const next = answers.shift();
			return next === undefined || next === "ok" ? ok(undefined) : err(next);
		};
		return provider;
	}

	test("no wait: a specific host-overloaded error, not 'all leased'; nothing leased or quarantined", async () => {
		const provider = poolOfOne([TIMEOUT("1"), TIMEOUT("1")]);
		const result = await claimDevices(input(provider, { request: request({ max: 1 }), load: overloaded }));
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toContain("host overloaded (load 30.0 ≥ 8 cores); retry later");
		expect(result.error).not.toContain("leased");
		expect(store.listLeases()).toEqual([]);
		expect(store.listDevices().find((d) => d.id === "1")?.quarantinedAt).toBeUndefined();
	});

	test("a device this claim booted and then skipped is shut down again (not quarantined)", async () => {
		const provider = poolOfOne([TIMEOUT("1"), TIMEOUT("1")]);
		await claimDevices(input(provider, { request: request({ max: 1 }), load: overloaded }));
		expect(provider.calls).toContain("shutdown 1");
		expect(store.listDevices().find((d) => d.id === "1")?.quarantinedAt).toBeUndefined();
	});

	test("a reused device that was already booted is still left alone when skipped", async () => {
		const provider = poolOfOne([TIMEOUT("1"), TIMEOUT("1")]);
		provider.devices[0] = { ...(provider.devices[0] as InventoryDevice), state: "booted" };
		provider.probe = provider.probeBooted;
		await claimDevices(input(provider, { request: request({ max: 1 }), load: overloaded }));
		expect(provider.calls).not.toContain("shutdown 1");
	});

	test("with --wait the skipped device is offered again on the next round and claimed once it answers", async () => {
		const provider = poolOfOne([TIMEOUT("1"), TIMEOUT("1"), "ok"]);
		let t = NOW;
		const result = await claimDevices(
			input(provider, {
				request: request({ max: 1 }),
				load: overloaded,
				waitMs: 60_000,
				now: () => t,
				sleep: async (ms) => {
					t += ms;
				},
			})
		);
		expect(result.success && result.data.claimed.map((c) => c.device.id)).toEqual(["1"]);
		expect(provider.calls.filter((c) => c === "probe 1")).toHaveLength(3);
	});

	test("with --wait on a host that stays overloaded: bounded, ends with the host-overloaded error", async () => {
		const provider = poolOfOne(Array.from({ length: 20 }, () => TIMEOUT("1")));
		let t = NOW;
		const result = await claimDevices(
			input(provider, {
				request: request({ max: 1 }),
				load: overloaded,
				waitMs: 600_000,
				now: () => t,
				sleep: async (ms) => {
					t += ms;
				},
			})
		);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toContain("host overloaded");
		expect(store.listLeases()).toEqual([]);
	});
});

describe("claim quarantine expiry respects max (ios-claim-path-R3)", () => {
	function quarantined(id: string, at: number) {
		store.recordDevice({ platform: "ios", id, name: `warden-iphone-17-${id}`, profile: "iphone-17" }, at);
		store.quarantineDevice(
			{ platform: "ios", id, name: `warden-iphone-17-${id}`, profile: "iphone-17" },
			`claim: ${id}: hung`,
			at
		);
	}
	function replacement(id: string): InventoryDevice {
		store.recordDevice({ platform: "ios", id, name: `warden-iphone-17-${id}`, profile: "iphone-17" }, NOW);
		return sim(id, { profile: "iphone-17" });
	}

	test("max=1 with a replacement: the expired quarantine stays, the pool stays at max", async () => {
		quarantined("1", NOW - QUARANTINE_TTL_MS);
		const provider = fakeProvider([sim("1", { profile: "iphone-17" }), replacement("2")]);
		const result = await claimDevices(input(provider, { request: request({ max: 1 }) }));
		expect(result.success && result.data.claimed.map((c) => c.device.id)).toEqual(["2"]);
		expect(store.listDevices().find((d) => d.id === "1")?.quarantinedAt).toBe(NOW - QUARANTINE_TTL_MS);
	});

	test("lifts only as many expired quarantines as the pool has room for", async () => {
		quarantined("1", NOW - QUARANTINE_TTL_MS);
		quarantined("3", NOW - QUARANTINE_TTL_MS);
		const provider = fakeProvider([
			sim("1", { profile: "iphone-17" }),
			replacement("2"),
			sim("3", { profile: "iphone-17" }),
		]);
		await claimDevices(input(provider, { request: request({ max: 2 }) }));
		const stillQuarantined = store.listDevices().filter((d) => d.quarantinedAt !== undefined);
		expect(stillQuarantined).toHaveLength(1);
	});
});
