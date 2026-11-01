import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkProxyShaping } from "@delacour/warden-driver/network-proxy";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import type { Lease } from "@delacour/warden-store/types";
import { resultFactory } from "@delacour/warden-types/result";
import { LazyLeaseNetworkProxy, type LazyLeaseProxyOptions } from "./lease-network-proxy";

describe("lazyLeaseNetworkProxy", () => {
	let dir: string;
	let store: Store;
	let opened: number;
	let lease: Lease;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-lazyproxy-"));
		store = storeLocator.open(join(dir, "warden.db"));
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
		new LazyLeaseNetworkProxy({
			leaseId,
			env: { WARDEN_HOME: dir },
			now: () => 1,
			openStore: () => {
				opened++;
				return resultFactory.ok(store);
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
		const first = await port.ensure({ kind: "offline" }, networkProxyShaping.conditionsFor({ kind: "offline" }, []));
		expect(first.success).toBe(false);
		expect(spawned[0]?.slice(0, 2)).toEqual(["/bin/warden", "__netproxy"]);
		await port.ensure({ kind: "offline" }, networkProxyShaping.conditionsFor({ kind: "offline" }, []));
		expect(opened).toBe(1);
	});

	test("a lease that is not in the store answers with an error naming it", async () => {
		const result = await proxy("gone").ensure(
			{ kind: "offline" },
			networkProxyShaping.conditionsFor({ kind: "offline" }, [])
		);
		expect(result).toEqual({ success: false, error: expect.stringContaining("gone") });
	});

	test("a store that cannot open is the ensure error", async () => {
		const port = proxy(lease.id, { openStore: () => resultFactory.err("locked") });
		expect(await port.ensure({ kind: "offline" }, networkProxyShaping.conditionsFor({ kind: "offline" }, []))).toEqual({
			success: false,
			error: "locked",
		});
	});
});
