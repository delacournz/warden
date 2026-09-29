import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ClaimPortsDeps,
	claimPorts,
	DEFAULT_PORT_SPAN,
	isPortFree,
	listPortLeases,
	parsePortSpec,
	releasePorts,
} from "./ports";
import { openStore, type Store } from "./store";
import type { Lease, Owner } from "./types";

let dir: string;
let store: Store;
const me: Owner = { kind: "agent", sessionId: "me", cwd: "/tmp" };
const other: Owner = { kind: "agent", sessionId: "other", cwd: "/tmp" };

const allFree = async () => true;
function deps(overrides: Partial<ClaimPortsDeps> = {}): ClaimPortsDeps {
	return { now: () => 1_000, pidAlive: () => false, isPortFree: allFree, ...overrides };
}

function ports(leases: Lease[]): number[] {
	return leases.flatMap((l) => (l.resource.kind === "port" ? [l.resource.port] : []));
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-ports-"));
	store = openStore(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("parsePortSpec", () => {
	test("from:span", () => {
		expect(parsePortSpec("8091:20")).toEqual({ success: true, data: { from: 8091, span: 20 } });
		expect(parsePortSpec(" 3208:5 ")).toEqual({ success: true, data: { from: 3208, span: 5 } });
	});

	test("bare port uses the default span", () => {
		expect(DEFAULT_PORT_SPAN).toBe(20);
		expect(parsePortSpec("8091")).toEqual({ success: true, data: { from: 8091, span: 20 } });
	});

	test("rejects invalid specs", () => {
		for (const bad of ["", "abc", "0", "65536", "8091:0", "8091:-1", "8091:x", "65530:10", "1.5", "80:2:3"]) {
			expect(parsePortSpec(bad).success).toBe(false);
		}
	});

	test("range may end exactly at 65535", () => {
		expect(parsePortSpec("65535:1")).toEqual({ success: true, data: { from: 65535, span: 1 } });
	});
});

describe("claimPorts", () => {
	test("leases the first free port with owner/label/pid/ttl", async () => {
		const res = await claimPorts(
			store,
			{ owner: me, from: 8091, span: 20, ttlMs: 500, label: "metro", pid: 42 },
			deps()
		);
		if (!res.success) throw new Error(res.error);
		expect(res.data).toHaveLength(1);
		const [lease] = res.data;
		expect(lease?.resource).toEqual({ kind: "port", port: 8091 });
		expect(lease?.owner).toEqual(me);
		expect(lease?.label).toBe("metro");
		expect(lease?.pid).toBe(42);
		expect(lease?.ttlMs).toBe(500);
		expect(lease?.acquiredAt).toBe(1_000);
		expect(store.listLeases()).toEqual(res.data);
	});

	test("skips ports that fail the bind probe", async () => {
		const res = await claimPorts(
			store,
			{ owner: me, from: 8091, span: 20, ttlMs: 500 },
			deps({ isPortFree: async (p) => p !== 8091 && p !== 8092 })
		);
		expect(res.success && ports(res.data)).toEqual([8093]);
	});

	test("skips live leases, even when the port probes free", async () => {
		store.insertLease({ resource: { kind: "port", port: 8091 }, owner: other, ttlMs: 10_000 }, 1_000);
		const res = await claimPorts(store, { owner: me, from: 8091, span: 20, ttlMs: 500 }, deps());
		expect(res.success && ports(res.data)).toEqual([8092]);
	});

	test("reclaims stale leases in range", async () => {
		const stale = store.insertLease({ resource: { kind: "port", port: 8091 }, owner: other, ttlMs: 10 }, 0);
		const res = await claimPorts(store, { owner: me, from: 8091, span: 20, ttlMs: 500 }, deps());
		expect(res.success && ports(res.data)).toEqual([8091]);
		expect(store.getLease(stale.id)).toBeUndefined();
	});

	test("count + step", async () => {
		const res = await claimPorts(
			store,
			{ owner: me, from: 5554, span: 32, count: 3, step: 2, ttlMs: 500 },
			deps({ isPortFree: async (p) => p !== 5556 })
		);
		expect(res.success && ports(res.data)).toEqual([5554, 5558, 5560]);
	});

	test("not enough free ports → error, nothing leased", async () => {
		const res = await claimPorts(
			store,
			{ owner: me, from: 8091, span: 3, count: 2, ttlMs: 500 },
			deps({ isPortFree: async (p) => p === 8092 })
		);
		expect(res).toEqual({ success: false, error: "no free port in 8091–8093" });
		expect(store.listLeases()).toEqual([]);
	});

	test("rejects invalid requests", async () => {
		expect((await claimPorts(store, { owner: me, from: 0, span: 1, ttlMs: 1 }, deps())).success).toBe(false);
		expect((await claimPorts(store, { owner: me, from: 80, span: 0, ttlMs: 1 }, deps())).success).toBe(false);
		expect((await claimPorts(store, { owner: me, from: 80, span: 5, count: 0, ttlMs: 1 }, deps())).success).toBe(false);
		expect((await claimPorts(store, { owner: me, from: 80, span: 5, step: 0, ttlMs: 1 }, deps())).success).toBe(false);
		expect((await claimPorts(store, { owner: me, from: 65535, span: 2, ttlMs: 1 }, deps())).success).toBe(false);
	});

	test("a lease taken by someone else between probe and txn is skipped", async () => {
		const res = await claimPorts(
			store,
			{ owner: me, from: 8091, span: 5, ttlMs: 500 },
			deps({
				isPortFree: async (p) => {
					if (p === 8091 && !store.findLeaseByResource({ kind: "port", port: 8091 })) {
						store.insertLease({ resource: { kind: "port", port: 8091 }, owner: other, ttlMs: 10_000 }, 1_000);
					}
					return true;
				},
			})
		);
		expect(res.success && ports(res.data)).toEqual([8092]);
	});
});

describe("releasePorts / listPortLeases", () => {
	async function seed(): Promise<{ mine: Lease; theirs: Lease }> {
		const a = await claimPorts(store, { owner: me, from: 8091, span: 1, ttlMs: 500 }, deps());
		const b = await claimPorts(store, { owner: other, from: 8092, span: 1, ttlMs: 500 }, deps());
		store.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "U1", name: "sim" }, owner: me, ttlMs: 500 },
			1_000
		);
		if (!a.success || !b.success || !a.data[0] || !b.data[0]) throw new Error("seed failed");
		return { mine: a.data[0], theirs: b.data[0] };
	}

	test("listPortLeases returns only port leases, ordered by port", async () => {
		await seed();
		expect(ports(listPortLeases(store))).toEqual([8091, 8092]);
	});

	test("release by port", async () => {
		const { mine } = await seed();
		const res = releasePorts(store, { by: "port", ports: [8091, 9999] });
		expect(res).toEqual({ released: [mine], denied: [], missing: ["9999"] });
		expect(ports(listPortLeases(store))).toEqual([8092]);
	});

	test("release by lease id ignores non-port leases", async () => {
		const { theirs } = await seed();
		const device = store.listLeases().find((l) => l.resource.kind === "device");
		const res = releasePorts(store, { by: "lease", ids: [theirs.id, device?.id ?? ""] });
		expect(res.released).toEqual([theirs]);
		expect(res.missing).toEqual([device?.id ?? ""]);
		expect(store.listLeases().some((l) => l.resource.kind === "device")).toBe(true);
	});

	test("release by owner", async () => {
		const { mine } = await seed();
		expect(releasePorts(store, { by: "owner", owner: me }).released).toEqual([mine]);
		expect(ports(listPortLeases(store))).toEqual([8092]);
	});

	test("onlyOwner denies other owners' leases", async () => {
		const { mine, theirs } = await seed();
		const res = releasePorts(store, { by: "port", ports: [8091, 8092] }, { onlyOwner: me });
		expect(res.released).toEqual([mine]);
		expect(res.denied).toEqual([theirs]);
		expect(ports(listPortLeases(store))).toEqual([8092]);
	});
});

describe("isPortFree (real sockets)", () => {
	test("bound port is busy, free again after stop", async () => {
		const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		const port = server.port;
		expect(await isPortFree(port)).toBe(false);
		expect(await isPortFree(port, "127.0.0.1")).toBe(false);
		server.stop(true);
		expect(await isPortFree(port)).toBe(true);
	});

	test("real claim skips a bound port", async () => {
		const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		try {
			const res = await claimPorts(
				store,
				{ owner: me, from: server.port, span: 5, ttlMs: 500 },
				deps({ isPortFree: (p) => isPortFree(p) })
			);
			expect(res.success && ports(res.data)[0]).not.toBe(server.port);
		} finally {
			server.stop(true);
		}
	});
});

describe("concurrency", () => {
	test("concurrent claimPorts processes get distinct ports", async () => {
		const dbPath = join(dir, "race.db");
		openStore(dbPath).close();
		const script = join(import.meta.dir, "ports.race-fixture.ts");
		const procs = Array.from({ length: 6 }, () =>
			Bun.spawn(["bun", script, dbPath], { stdout: "pipe", stderr: "inherit" })
		);
		const got = await Promise.all(procs.map(async (p) => Number((await new Response(p.stdout).text()).trim())));
		expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0, 0, 0]);
		expect(new Set(got).size).toBe(6);
		expect(got.every((p) => p >= 47_100 && p < 47_120)).toBe(true);
	});
});
