import { existsSync, unlinkSync } from "node:fs";
import net from "node:net";
import type { Result } from "@delacour/warden-types/result";
import type { RunnerAddress } from "./types";

/**
 * A unix socket in front of the runner's TCP listener, so the TS side keeps `socketTransport` / `connectSimd`
 * and never learns about tunnel addresses. One upstream TCP connection per client, bytes copied both ways with
 * backpressure (a slow reader pauses the writer instead of buffering a screenshot in memory).
 */
export type RunnerProxy = {
	socketPath: string;
	/** clients connected now */
	connections(): number;
	/** `now()` of the last byte either way, or of the last connect/disconnect; the idle clock's zero */
	lastActivity(): number;
	/** write one NDJSON line (no newline) to every connected client, e.g. a `fatal` event */
	broadcast(line: string): Promise<void>;
	/** stop listening, hang up on every client, remove the socket file */
	close(): Promise<void>;
};

export type ProxyOptions = {
	socketPath: string;
	/** where the runner is right now; read per connection so a re-read tunnel address is picked up. undefined: refuse */
	target: () => RunnerAddress | undefined;
	now: () => number;
	log?: (line: string) => void;
};

/** Copy `from` to `to`, pausing `from` while `to` is full. */
function forward(from: net.Socket, to: net.Socket, touch: () => void): void {
	from.on("data", (chunk: Buffer) => {
		touch();
		if (!to.write(chunk)) {
			from.pause();
			to.once("drain", () => from.resume());
		}
	});
	from.on("end", () => to.end());
}

function unlinkQuietly(path: string): void {
	try {
		if (existsSync(path)) unlinkSync(path);
	} catch {
		// already gone
	}
}

export function startProxy(opts: ProxyOptions): Promise<Result<RunnerProxy, string>> {
	const log = opts.log ?? (() => undefined);
	const clients = new Set<net.Socket>();
	let activity = opts.now();
	const touch = (): void => {
		activity = opts.now();
	};

	const server = net.createServer((client) => {
		touch();
		clients.add(client);
		client.pause();
		const address = opts.target();
		if (address === undefined) {
			log("proxy: no runner address, closing a client");
			client.destroy();
			return;
		}
		const upstream = net.connect({ host: address.host, port: address.port });
		upstream.setNoDelay(true);
		const end = (): void => {
			client.destroy();
			upstream.destroy();
		};
		upstream.once("connect", () => {
			forward(client, upstream, touch);
			forward(upstream, client, touch);
			client.resume();
		});
		upstream.on("error", (error) => {
			log(`proxy: runner [${address.host}]:${address.port}: ${error.message}`);
			end();
		});
		client.on("error", end);
		upstream.on("close", end);
		client.on("close", () => {
			clients.delete(client);
			touch();
			upstream.destroy();
		});
	});

	return new Promise((resolve) => {
		server.once("error", (error) =>
			resolve({ success: false, error: `cannot listen on ${opts.socketPath}: ${error.message}` })
		);
		unlinkQuietly(opts.socketPath);
		server.listen(opts.socketPath, () => {
			resolve({
				success: true,
				data: {
					socketPath: opts.socketPath,
					connections: () => clients.size,
					lastActivity: () => activity,
					broadcast: async (line) => {
						await Promise.all(
							[...clients].map((client) => new Promise<void>((done) => client.write(`${line}\n`, () => done())))
						);
					},
					close: () =>
						new Promise<void>((done) => {
							for (const client of clients) client.destroy();
							server.close(() => {
								unlinkQuietly(opts.socketPath);
								done();
							});
						}),
				},
			});
		});
	});
}
