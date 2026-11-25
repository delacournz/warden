import { afterEach, describe, expect, test } from "bun:test";
import { el, fakeDriver, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import type { Driver } from "@delacour/warden-e2e/driver/driver.types";
import type { TransportFactory } from "@delacour/warden-e2e/driver/ios/simd-transport";
import { connectRemoteDriver } from "@delacour/warden-e2e/driver/remote/remote-client";
import { ok, type Result } from "@delacour/warden-types/result";
import type { UiDevice } from "../agent-ui/device";
import { type TestContext, testContext } from "../testing";
import { createDriverServeCommand, type DriverServeDeps } from "./driver-serve";

const ctxs: TestContext[] = [];
afterEach(() => {
	for (const ctx of ctxs.splice(0)) ctx.cleanup();
});

const ME = { kind: "agent", sessionId: "me", cwd: "/" } as const;
const OTHER = { kind: "agent", sessionId: "other", cwd: "/" } as const;

function context(argv: string[]): TestContext {
	const ctx = testContext(argv);
	ctx.env.WARDEN_SESSION_ID = "me";
	ctxs.push(ctx);
	return ctx;
}

type Wired = { deps: DriverServeDeps; transport: TransportFactory; opened: UiDevice[] };

/** The command's stdin/stdout as in-memory pipes, and a transport for the client end. */
function wire(driver: Driver): Wired {
	const toServer = new TransformStream<Uint8Array, Uint8Array>();
	const toClient = new TransformStream<Uint8Array, Uint8Array>();
	const out = toClient.writable.getWriter();
	const opened: UiDevice[] = [];
	const deps: DriverServeDeps = {
		openDriver: async (_ctx, device): Promise<Result<Driver, string>> => {
			opened.push(device);
			return ok(driver);
		},
		input: () => toServer.readable,
		write: (bytes) => {
			void out.write(bytes);
		},
	};
	const transport: TransportFactory = async (handlers) => {
		const writer = toServer.writable.getWriter();
		const reader = toClient.readable.getReader();
		const decoder = new TextDecoder();
		let buffered = "";
		void (async () => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffered += decoder.decode(value);
				for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
					handlers.onLine(buffered.slice(0, nl));
					buffered = buffered.slice(nl + 1);
				}
			}
			handlers.onClose({ exitCode: 0, stderrTail: [] });
		})();
		const encoder = new TextEncoder();
		return {
			success: true,
			data: {
				send: (data) => void writer.write(encoder.encode(data)),
				close: async () => void (await writer.close().catch(() => undefined)),
			},
		};
	};
	return { deps, transport, opened };
}

const screen = snapshotOf([el("button", { id: "go", label: "Go" })], { platform: "ios" });

describe("warden __driver-serve", () => {
	test("--lease is required", async () => {
		const ctx = context([]);
		const { deps } = wire(fakeDriver({ screens: [screen] }));
		expect(await createDriverServeCommand(deps).run(ctx)).toBe(1);
	});

	test("an unknown lease exits 2 and serves nothing", async () => {
		const ctx = context(["--lease", "nope"]);
		const { deps, opened } = wire(fakeDriver({ screens: [screen] }));
		expect(await createDriverServeCommand(deps).run(ctx)).toBe(2);
		expect(opened).toEqual([]);
		expect(ctx.stderr.join("\n")).toContain("no lease nope");
	});

	test("another owner's lease exits 2", async () => {
		const ctx = context([]);
		const lease = ctx.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "SIM-1", name: "warden-iphone-1" },
				owner: OTHER,
				ttlMs: 60_000,
			},
			ctx.now()
		);
		ctx.argv = ["--lease", lease.id];
		const { deps, opened } = wire(fakeDriver({ screens: [screen] }));
		expect(await createDriverServeCommand(deps).run(ctx)).toBe(2);
		expect(opened).toEqual([]);
		expect(ctx.stderr.join("\n")).toContain("not yours");
	});

	test("a lease that is not a device exits 2", async () => {
		const ctx = context([]);
		const lease = ctx.db.insertLease({ resource: { kind: "port", port: 9000 }, owner: ME, ttlMs: 60_000 }, ctx.now());
		ctx.argv = ["--lease", lease.id];
		const { deps } = wire(fakeDriver({ screens: [screen] }));
		expect(await createDriverServeCommand(deps).run(ctx)).toBe(2);
	});

	test("a failed driver open exits 3", async () => {
		const ctx = context([]);
		const lease = ctx.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "SIM-1", name: "warden-iphone-1" }, owner: ME, ttlMs: 60_000 },
			ctx.now()
		);
		ctx.argv = ["--lease", lease.id];
		const { deps } = wire(fakeDriver({ screens: [screen] }));
		deps.openDriver = async () => ({ success: false, error: "no helper" });
		expect(await createDriverServeCommand(deps).run(ctx)).toBe(3);
	});

	test("serves the leased device's driver on stdio until the client goes away", async () => {
		const ctx = context([]);
		const lease = ctx.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "SIM-1", name: "warden-iphone-1" }, owner: ME, ttlMs: 60_000 },
			ctx.now()
		);
		ctx.argv = ["--lease", lease.id];
		const driver = fakeDriver({ screens: [screen], platform: "ios", id: "SIM-1" });
		const { deps, transport, opened } = wire(driver);
		const exit = createDriverServeCommand(deps).run(ctx);
		const client = await connectRemoteDriver({ transport, label: "pipe", readyTimeoutMs: 5000 });
		if (!client.success) throw new Error(client.error.message);
		expect(client.data.ready.id).toBe("SIM-1");
		expect(await client.data.driver().tap({ x: 1, y: 2 })).toEqual({ success: true, data: undefined });
		await client.data.close();
		expect(await exit).toBe(0);
		expect(opened.map((d) => [d.udid, d.platform])).toEqual([["SIM-1", "ios"]]);
		expect(driver.callsOf("tap")).toHaveLength(1);
		expect(ctx.stdout).toEqual([]);
	});
});
