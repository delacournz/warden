import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunnerProxy, startProxy } from "./proxy";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An in-memory TCP runner: sends a ready line on connect, echoes every line back prefixed `echo:`. */
async function fakeRunner() {
	const received: string[] = [];
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.write('{"event":"ready"}\n');
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				received.push(line);
				socket.write(`echo:${line}\n`);
			}
		});
		socket.on("error", () => undefined);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => {
		for (const socket of sockets) socket.destroy();
		server.close();
	});
	const { port } = server.address() as net.AddressInfo;
	return { port, received, sockets };
}

async function proxyTo(port: number | undefined): Promise<RunnerProxy> {
	const dir = mkdtempSync(join(tmpdir(), "wdn-proxy-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const started = await startProxy({
		socketPath: join(dir, "r.sock"),
		target: () => (port === undefined ? undefined : { host: "127.0.0.1", port }),
		now: Date.now,
	});
	if (!started.success) throw new Error(started.error);
	cleanups.push(() => started.data.close());
	return started.data;
}

function lineClient(socketPath: string) {
	const lines: string[] = [];
	let buffer = "";
	let closed = false;
	const socket = net.connect(socketPath);
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
			lines.push(buffer.slice(0, at));
			buffer = buffer.slice(at + 1);
		}
	});
	socket.on("error", () => undefined);
	socket.on("close", () => {
		closed = true;
	});
	cleanups.push(() => void socket.destroy());
	return { socket, lines, isClosed: () => closed };
}

async function until(read: () => boolean, ms = 3000): Promise<void> {
	const end = Date.now() + ms;
	while (!read()) {
		if (Date.now() > end) throw new Error("timed out");
		await Bun.sleep(5);
	}
}

describe("proxy", () => {
	test("the runner's ready line reaches the client and requests reach the runner", async () => {
		const runner = await fakeRunner();
		const proxy = await proxyTo(runner.port);
		const client = lineClient(proxy.socketPath);
		await until(() => client.lines.length === 1);
		expect(client.lines[0]).toBe('{"event":"ready"}');
		client.socket.write('{"id":"1","op":"ping"}\n');
		await until(() => client.lines.length === 2);
		expect(client.lines[1]).toBe('echo:{"id":"1","op":"ping"}');
		expect(proxy.connections()).toBe(1);
	});

	test("a request written in pieces arrives whole", async () => {
		const runner = await fakeRunner();
		const proxy = await proxyTo(runner.port);
		const client = lineClient(proxy.socketPath);
		await until(() => client.lines.length === 1);
		for (const piece of ['{"id":"2",', '"op":"sna', 'pshot"}', "\n"]) {
			client.socket.write(piece);
			await Bun.sleep(15);
		}
		await until(() => runner.received.length === 1);
		expect(runner.received[0]).toBe('{"id":"2","op":"snapshot"}');
	});

	test("a multi-megabyte line goes both ways intact (backpressure, no loss)", async () => {
		const runner = await fakeRunner();
		const proxy = await proxyTo(runner.port);
		const client = lineClient(proxy.socketPath);
		await until(() => client.lines.length === 1);
		const big = "x".repeat(6 * 1024 * 1024);
		client.socket.write(`${big}\n`);
		await until(() => client.lines.length === 2, 10_000);
		expect(runner.received[0]?.length).toBe(big.length);
		expect(client.lines[1]).toBe(`echo:${big}`);
	});

	test("two clients are independent connections to the runner", async () => {
		const runner = await fakeRunner();
		const proxy = await proxyTo(runner.port);
		const a = lineClient(proxy.socketPath);
		const b = lineClient(proxy.socketPath);
		await until(() => a.lines.length === 1 && b.lines.length === 1);
		expect(runner.sockets.size).toBe(2);
		a.socket.destroy();
		await until(() => proxy.connections() === 1);
		await until(() => runner.sockets.size === 1);
	});

	test("the runner going away hangs up on the client", async () => {
		const runner = await fakeRunner();
		const proxy = await proxyTo(runner.port);
		const client = lineClient(proxy.socketPath);
		await until(() => client.lines.length === 1);
		for (const socket of runner.sockets) socket.destroy();
		await until(() => client.isClosed());
	});

	test("no runner address: the client is closed at once", async () => {
		const proxy = await proxyTo(undefined);
		const client = lineClient(proxy.socketPath);
		await until(() => client.isClosed());
	});

	test("an unreachable runner closes the client and logs why", async () => {
		const free = net.createServer();
		await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
		const { port } = free.address() as net.AddressInfo;
		await new Promise((resolve) => free.close(resolve));
		const logs: string[] = [];
		const dir = mkdtempSync(join(tmpdir(), "wdn-proxy-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const started = await startProxy({
			socketPath: join(dir, "r.sock"),
			target: () => ({ host: "127.0.0.1", port }),
			now: Date.now,
			log: (line) => logs.push(line),
		});
		if (!started.success) throw new Error(started.error);
		cleanups.push(() => started.data.close());
		const client = lineClient(started.data.socketPath);
		await until(() => client.isClosed());
		expect(logs.join("\n")).toContain("proxy: runner");
	});

	test("broadcast reaches every client; close removes the socket", async () => {
		const runner = await fakeRunner();
		const proxy = await proxyTo(runner.port);
		const client = lineClient(proxy.socketPath);
		await until(() => client.lines.length === 1);
		await proxy.broadcast('{"event":"fatal"}');
		await until(() => client.lines.length === 2);
		expect(client.lines[1]).toBe('{"event":"fatal"}');
		await proxy.close();
		expect(await Bun.file(proxy.socketPath).exists()).toBe(false);
	});

	test("lastActivity moves with traffic", async () => {
		const runner = await fakeRunner();
		let t = 100;
		const dir = mkdtempSync(join(tmpdir(), "wdn-proxy-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const started = await startProxy({
			socketPath: join(dir, "r.sock"),
			target: () => ({ host: "127.0.0.1", port: runner.port }),
			now: () => t,
		});
		if (!started.success) throw new Error(started.error);
		cleanups.push(() => started.data.close());
		const client = lineClient(started.data.socketPath);
		await until(() => client.lines.length === 1);
		t = 500;
		client.socket.write('{"id":"1"}\n');
		await until(() => client.lines.length === 2);
		expect(started.data.lastActivity()).toBe(500);
	});
});
