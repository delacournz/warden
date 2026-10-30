import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "@delacour/warden-core/store";
import type { Lease } from "@delacour/warden-core/types";
import { err, ok } from "@delacour/warden-types/result";
import { faultNotes, type LazyLeaseProxyOptions, lazyLeaseNetworkProxy, proxyConditionsFor } from "./network-proxy";
import { fakeProxy } from "./network-proxy.testing";

describe("proxyConditionsFor", () => {
	test("a preset shapes with its table row and keeps the faults", () => {
		const faults = [{ match: "api.*", action: { kind: "reset" as const } }];
		const result = proxyConditionsFor({ kind: "preset", preset: "3g" }, faults);
		expect(result.params).toMatchObject({ latencyMs: 100, downKbps: 780, upKbps: 330 });
		expect(result.faults).toEqual(faults);
	});

	test("offline refuses connections", () => {
		expect(proxyConditionsFor({ kind: "offline" }, []).params).toEqual({ offline: "refuse" });
	});
});

describe("faultNotes", () => {
	test("only status faults need a note, and it says https is reset", () => {
		const notes = faultNotes([
			{ match: "api.example.com", action: { kind: "status", code: 503 } },
			{ match: "*.cdn.net", action: { kind: "reset" } },
			{ match: "slow.io", action: { kind: "delay", ms: 500 } },
		]);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("503");
		expect(notes[0]).toContain("api.example.com");
		expect(notes[0]).toContain("https://");
	});

	test("none for no faults", () => {
		expect(faultNotes([])).toEqual([]);
	});
});

describe("fakeProxy", () => {
	test("ensure makes it live, stop clears it", async () => {
		const proxy = fakeProxy(19_100);
		expect(await proxy.current()).toBeUndefined();
		await proxy.ensure({ kind: "online" }, { params: {}, faults: [] });
		expect(await proxy.current()).toEqual({ host: "127.0.0.1", port: 19_100 });
		await proxy.stop();
		expect(await proxy.current()).toBeUndefined();
	});
});

describe("lazyLeaseNetworkProxy", () => {
	let dir: string;
	let store: Store;
	let opened: number;
	let lease: Lease;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-lazyproxy-"));
		store = openStore(join(dir, "warden.db"));
		opened = 0;
		lease = store.insertLease(
			{
				resource: { kind: "device", platform: "android", id: "emulator-5554", name: "Pixel" },
				owner: { kind: "agent", sessionId: "s", cwd: "/tmp" },
				ttlMs: 60_000,
			},
			1
		);
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const proxy = (leaseId: string, extra: Partial<LazyLeaseProxyOptions> = {}) =>
		lazyLeaseNetworkProxy({
			leaseId,
			env: { WARDEN_HOME: dir },
			now: () => 1,
			openStore: () => {
				opened++;
				return ok(store);
			},
			...extra,
		});

	test("building it and asking for the current address, an update or a stop never opens the store", async () => {
		const port = proxy(lease.id);
		expect(await port.current()).toBeUndefined();
		expect((await port.update({ params: { offline: "refuse" } })).success).toBe(false);
		await port.stop();
		expect(opened).toBe(0);
	});

	test("ensure opens the store once, reads the lease and starts the proxy with the given command", async () => {
		const spawned: (readonly string[])[] = [];
		const port = proxy(lease.id, {
			command: ["/bin/warden", "__netproxy"],
			proxyDeps: {
				spawn: (argv) => {
					spawned.push(argv);
					return 4321;
				},
				pidAlive: () => false,
				readyTimeoutMs: 30,
			},
		});
		const first = await port.ensure({ kind: "offline" }, proxyConditionsFor({ kind: "offline" }, []));
		expect(first.success).toBe(false);
		expect(spawned[0]?.slice(0, 2)).toEqual(["/bin/warden", "__netproxy"]);
		await port.ensure({ kind: "offline" }, proxyConditionsFor({ kind: "offline" }, []));
		expect(opened).toBe(1);
	});

	test("a lease that is not in the store answers with an error naming it", async () => {
		const result = await proxy("gone").ensure({ kind: "offline" }, proxyConditionsFor({ kind: "offline" }, []));
		expect(result).toEqual({ success: false, error: expect.stringContaining("gone") });
	});

	test("a store that cannot open is the ensure error", async () => {
		const port = proxy(lease.id, { openStore: () => err("locked") });
		expect(await port.ensure({ kind: "offline" }, proxyConditionsFor({ kind: "offline" }, []))).toEqual({
			success: false,
			error: "locked",
		});
	});
});
