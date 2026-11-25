import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { el, fakeDriver, snapshotOf } from "../driver.testing";
import type { TransportFactory } from "../ios/simd-transport";
import { stdioTransport } from "../ios/simd-transport";
import { connectRemoteDriver, type RemoteClient } from "./remote-client";
import { type StdioDriverServer, serveDriverStdio } from "./remote-server";

const clients: RemoteClient[] = [];
const servers: StdioDriverServer[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close();
	for (const server of servers.splice(0)) await server.stop();
});

const screen = snapshotOf([el("button", { id: "go", label: "Go" })], { platform: "ios" });

/** An in-memory pipe pair: what the client writes the server reads, and back. */
function pipePair(driver: ReturnType<typeof fakeDriver>): { transport: TransportFactory; server: StdioDriverServer } {
	const toServer = new TransformStream<Uint8Array, Uint8Array>();
	const toClient = new TransformStream<Uint8Array, Uint8Array>();
	const serverWriter = toClient.writable.getWriter();
	const server = serveDriverStdio({
		driver,
		input: toServer.readable,
		write: (bytes) => {
			void serverWriter.write(bytes);
		},
	});
	servers.push(server);
	const encoder = new TextEncoder();
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
				let nl = buffered.indexOf("\n");
				while (nl >= 0) {
					handlers.onLine(buffered.slice(0, nl));
					buffered = buffered.slice(nl + 1);
					nl = buffered.indexOf("\n");
				}
			}
			handlers.onClose({ exitCode: 0, stderrTail: [] });
		})();
		return {
			success: true,
			data: {
				send: (data) => {
					void writer.write(encoder.encode(data));
				},
				close: async () => {
					await writer.close().catch(() => undefined);
				},
			},
		};
	};
	return { transport, server };
}

async function connect(transport: TransportFactory): Promise<RemoteClient> {
	const connected = await connectRemoteDriver({ transport, label: "test pipe", readyTimeoutMs: 5000 });
	if (!connected.success) throw new Error(connected.error.message);
	clients.push(connected.data);
	return connected.data;
}

describe("remote driver over stdio", () => {
	test("a transport target gets the ready event and drives the served driver", async () => {
		const driver = fakeDriver({ screens: [screen], platform: "ios", id: "SIM-1" });
		const { transport } = pipePair(driver);
		const client = await connect(transport);
		expect(client.ready.id).toBe("SIM-1");
		const remote = client.driver();
		expect(await remote.tap({ x: 3, y: 4 })).toEqual({ success: true, data: undefined });
		const taken = await remote.snapshot();
		expect(taken.success && taken.data.flat.map((e) => e.label)).toEqual(["Go"]);
		expect(driver.callsOf("tap")).toEqual([{ method: "tap", point: { x: 3, y: 4 } }]);
	});

	test("the server finishes when its input ends, and closes the driver", async () => {
		const driver = fakeDriver({ screens: [screen], platform: "ios" });
		const { transport, server } = pipePair(driver);
		const client = await connect(transport);
		await client.close();
		await server.finished;
		await server.stop();
		expect(driver.closed).toBe(true);
	});

	test("a spawned server process is reached through stdioTransport", async () => {
		const fixture = join(import.meta.dir, "remote-stdio.fixture.ts");
		const client = await connect(stdioTransport({ cmd: [process.execPath, fixture] }));
		expect(client.ready.platform).toBe("android");
		const remote = client.driver();
		expect(await remote.tap({ x: 1, y: 1 })).toEqual({ success: true, data: undefined });
		const shot = await remote.snapshot();
		expect(shot.success && shot.data.flat.map((e) => e.label)).toEqual(["From the fixture"]);
	});

	test("a transport that dies before ready fails the connect", async () => {
		const connected = await connectRemoteDriver({
			transport: stdioTransport({ cmd: [process.execPath, "-e", "process.exit(3)"] }),
			label: "dead",
			readyTimeoutMs: 5000,
		});
		expect(connected.success).toBe(false);
		if (!connected.success) expect(connected.error.code).toBe("E_HELPER_CRASHED");
	});
});
