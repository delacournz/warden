import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { el, failWith, fakeDriver, snapshotOf } from "../driver.testing";
import type { Driver, DriverCapabilities } from "../driver.types";
import { canDetectAlerts } from "../observation-cache";
import { canSelectAll, canSetText } from "../typing";
import { connectRemoteDriver, type RemoteClient } from "./remote-client";
import { type RemoteServer, serveDriver } from "./remote-server";

const dirs: string[] = [];
const servers: RemoteServer[] = [];
const clients: RemoteClient[] = [];

function socketPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "wrd-"));
	dirs.push(dir);
	return join(dir, "d.sock");
}

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close();
	for (const server of servers.splice(0)) await server.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve(driver: Driver, opts: Partial<Parameters<typeof serveDriver>[0]> = {}): Promise<RemoteServer> {
	const server = await serveDriver({ driver, socketPath: socketPath(), ...opts });
	servers.push(server);
	return server;
}

async function connect(server: RemoteServer, opts: { requestTimeoutMs?: number } = {}): Promise<RemoteClient> {
	const connected = await connectRemoteDriver({ socketPath: server.socketPath, readyTimeoutMs: 2000, ...opts });
	if (!connected.success) throw new Error(connected.error.message);
	clients.push(connected.data);
	return connected.data;
}

const screen = snapshotOf([el("button", { id: "go", label: "Go" }), el("text", { label: "Hello" })], {
	platform: "android",
});

describe("remote driver", () => {
	test("the ready event names the driver, its capabilities and optional ops", async () => {
		const driver = fakeDriver({ screens: [screen], platform: "android", id: "emulator-5554", selectAll: true });
		const client = await connect(await serve(driver));
		expect(client.ready.platform).toBe("android");
		expect(client.ready.id).toBe("emulator-5554");
		expect(client.ready.optional).toEqual(["selectAll"]);
		const remote = client.driver();
		expect(remote.platform).toBe("android");
		expect(remote.id).toBe("emulator-5554");
		expect(remote.capabilities).toEqual(driver.capabilities);
		expect(canSelectAll(remote)).toBe(true);
		expect(canSetText(remote)).toBe(false);
	});

	test("calls reach the served driver with their arguments; omitted options stay undefined", async () => {
		const driver = fakeDriver({ screens: [screen], platform: "android" });
		const remote = (await connect(await serve(driver))).driver();
		expect(await remote.tap({ x: 10, y: 20 })).toEqual({ success: true, data: undefined });
		expect(await remote.tap({ x: 1, y: 2 }, { count: 2 })).toEqual({ success: true, data: undefined });
		await remote.app.launch("com.example", { relaunch: false });
		expect(driver.callsOf("tap")).toEqual([
			{ method: "tap", point: { x: 10, y: 20 } },
			{ method: "tap", point: { x: 1, y: 2 }, opts: { count: 2 } },
		]);
		expect(driver.callsOf("app.launch")).toEqual([
			{ method: "app.launch", bundleId: "com.example", opts: { relaunch: false } },
		]);
	});

	test("clock goes over the wire with its options and returns the state", async () => {
		const driver = fakeDriver({ screens: [screen], platform: "android", wallNow: () => 5_000 });
		const remote = (await connect(await serve(driver))).driver();
		const result = await remote.clock({ kind: "offset", ms: 1_000 }, { relaunch: true });
		expect(result).toMatchObject({ success: true, data: { offsetMs: 1_000, nowMs: 6_000 } });
		expect(driver.callsOf("clock")).toEqual([{ method: "clock", op: { kind: "offset", ms: 1_000 } }]);
	});

	test("a snapshot comes back with flat holding the tree's own nodes in preorder", async () => {
		const remote = (await connect(await serve(fakeDriver({ screens: [screen], platform: "android" })))).driver();
		const taken = await remote.snapshot({ interactiveOnly: true });
		if (!taken.success) throw new Error(taken.error.message);
		expect(taken.data.flat.map((e) => e.id)).toEqual(screen.flat.map((e) => e.id));
		expect(taken.data.flat[0]).toBe(taken.data.elements[0]);
	});

	test("a reply far larger than one socket write arrives whole", async () => {
		const many = Array.from({ length: 3000 }, (_, i) =>
			el("text", { id: `row-${i}`, label: `Row number ${i} ${"x".repeat(40)}` })
		);
		const big = snapshotOf(many, { platform: "android" });
		const remote = (await connect(await serve(fakeDriver({ screens: [big], platform: "android" })))).driver();
		const taken = await remote.snapshot();
		if (!taken.success) throw new Error(taken.error.message);
		expect(taken.data.flat).toHaveLength(big.flat.length);
	});

	test("a driver failure is returned, not thrown", async () => {
		const driver = fakeDriver({
			screens: [screen],
			onCall: (call) => (call.method === "tap" ? failWith("E_NO_ELEMENT", "nothing there") : undefined),
		});
		const remote = (await connect(await serve(driver))).driver();
		const tapped = await remote.tap({ x: 0, y: 0 });
		expect(tapped.success).toBe(false);
		if (!tapped.success) expect(tapped.error.code).toBe("E_NO_ELEMENT");
	});

	test("capabilities follow the served driver after each op", async () => {
		const base = fakeDriver({ screens: [screen], platform: "android" });
		let caps: DriverCapabilities = { ...base.capabilities, nativeSettle: false };
		const driver: Driver = {
			...base,
			get capabilities() {
				return caps;
			},
			snapshot: async (opts) => {
				caps = { ...caps, nativeSettle: true };
				return base.snapshot(opts);
			},
		};
		const remote = (await connect(await serve(driver))).driver();
		expect(remote.capabilities.nativeSettle).toBe(false);
		await remote.snapshot();
		expect(remote.capabilities.nativeSettle).toBe(true);
	});

	test("a screenshot's bytes survive the trip", async () => {
		const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
		const driver = fakeDriver({
			screens: [screen],
			onCall: (call) => (call.method === "screenshot" ? { data: { png } } : undefined),
		});
		const remote = (await connect(await serve(driver))).driver();
		const shot = await remote.screenshot();
		if (!shot.success) throw new Error(shot.error.message);
		expect(shot.data.png).toEqual(png);
	});

	test("ops from two clients run one at a time", async () => {
		const order: string[] = [];
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const base = fakeDriver({ screens: [screen] });
		const driver: Driver = {
			...base,
			tap: async (point) => {
				order.push(`start ${point.x}`);
				if (point.x === 1) await gate;
				order.push(`end ${point.x}`);
				return { success: true, data: undefined };
			},
		};
		const server = await serve(driver);
		const a = (await connect(server)).driver();
		const b = (await connect(server)).driver();
		const first = a.tap({ x: 1, y: 0 });
		await Bun.sleep(20);
		const second = b.tap({ x: 2, y: 0 });
		await Bun.sleep(20);
		expect(order).toEqual(["start 1"]);
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(["start 1", "end 1", "start 2", "end 2"]);
	});

	test("closing the client only disconnects; stopping the server closes the driver", async () => {
		const driver = fakeDriver({ screens: [screen] });
		const server = await serve(driver);
		const client = await connect(server);
		await client.driver().close();
		expect(driver.closed).toBe(false);
		await server.stop();
		servers.splice(0);
		expect(driver.closed).toBe(true);
	});

	test("a request in flight when the server goes away fails E_HELPER_CRASHED", async () => {
		const base = fakeDriver({ screens: [screen] });
		const driver: Driver = { ...base, tap: () => new Promise(() => undefined) };
		const server = await serve(driver, { closeDriver: false, stopWaitMs: 10 });
		const remote = (await connect(server)).driver();
		const pending = remote.tap({ x: 0, y: 0 });
		await Bun.sleep(20);
		server.drop();
		const tapped = await pending;
		expect(tapped.success).toBe(false);
		if (!tapped.success) expect(tapped.error.code).toBe("E_HELPER_CRASHED");
	});

	test("a request that takes longer than the client's timeout fails E_TIMEOUT", async () => {
		const base = fakeDriver({ screens: [screen] });
		const driver: Driver = { ...base, health: () => new Promise(() => undefined) };
		const remote = (
			await connect(await serve(driver, { closeDriver: false, stopWaitMs: 10 }), { requestTimeoutMs: 50 })
		).driver();
		const health = await remote.health();
		expect(health.success).toBe(false);
		if (!health.success) expect(health.error.code).toBe("E_TIMEOUT");
	});

	test("shutdown is acknowledged and handed to the host", async () => {
		const asked: string[] = [];
		const server = await serve(fakeDriver({ screens: [screen] }), { onShutdown: () => asked.push("shutdown") });
		const client = await connect(server);
		expect((await client.request("shutdown")).success).toBe(true);
		expect(asked).toEqual(["shutdown"]);
	});

	test("an unknown op is E_BAD_REQUEST", async () => {
		const client = await connect(await serve(fakeDriver({ screens: [screen] })));
		const answer = await client.request("explode");
		expect(answer.success).toBe(false);
		if (!answer.success) expect(answer.error.code).toBe("E_BAD_REQUEST");
	});

	test("the server reports idle once no client has been connected for idleMs", async () => {
		const idle: number[] = [];
		const server = await serve(fakeDriver({ screens: [screen] }), { idleMs: 60, onIdle: () => idle.push(1) });
		const client = await connect(server);
		await Bun.sleep(100);
		expect(idle).toEqual([]);
		await client.close();
		clients.splice(0);
		await Bun.sleep(120);
		expect(idle).toEqual([1]);
	});

	test("an android driver's alertIn is answered locally from the snapshot", async () => {
		const driver = fakeDriver({ screens: [screen], platform: "android" });
		const served: Driver = Object.assign(driver, { alertIn: () => null });
		const remote = (await connect(await serve(served, { alertIn: "android" }))).driver();
		expect(canDetectAlerts(remote)).toBe(true);
		if (canDetectAlerts(remote)) expect(remote.alertIn(screen)).toBeNull();
	});
});
