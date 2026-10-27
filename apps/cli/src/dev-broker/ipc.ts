import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket, SocketListener } from "bun";
import { z } from "zod";
import { wireRequestSchema } from "./broker.schema";
import {
	type BrokerRequest,
	type BrokerResult,
	brokerErr,
	type ResponseOf,
	type WireRequest,
	type WireResponse,
} from "./broker.types";

/** sun_path is 104 bytes on macOS (108 on Linux), one of them the NUL. */
const MAX_SOCKET_PATH_BYTES = 100;
/** a request line is a few KB at most (an eval expression); a longer one is refused */
const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 500;
/** headroom a call keeps over the handler's own `timeoutMs` */
const TIMEOUT_MARGIN_MS = 5_000;

/** `<logDir>/broker.sock`, else a short path under the temp dir (sockets have a path length limit). */
export function chooseSocketPath(logDir: string, tmp: () => string = tmpdir): string {
	const preferred = join(logDir, "broker.sock");
	if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
	const hash = createHash("sha1").update(logDir).digest("hex").slice(0, 12);
	return join(tmp(), `warden-${hash}.sock`);
}

/** Answers one request. Failures are `BrokerResult` errors; a throw becomes a `cdp_protocol` error. */
export type RequestHandler = (method: string, params: unknown) => Promise<BrokerResult<unknown>>;

export type BrokerServer = {
	socketPath: string;
	/** stops listening, drops open connections, removes the socket file */
	close(): Promise<void>;
};

type ServerData = { buffer: string; decoder: TextDecoder; pending: Buffer; closed: boolean };
type ServerSocket = Socket<ServerData>;

/** Writes as much as the socket takes now and keeps the rest for `drain`. */
function flush(socket: ServerSocket): void {
	const data = socket.data;
	while (data.pending.length > 0 && !data.closed) {
		const written = socket.write(data.pending);
		if (written <= 0) return;
		data.pending = data.pending.subarray(written);
	}
}

function reply(socket: ServerSocket, response: WireResponse): void {
	if (socket.data.closed) return;
	socket.data.pending = Buffer.concat([socket.data.pending, Buffer.from(`${JSON.stringify(response)}\n`)]);
	flush(socket);
}

async function answer(socket: ServerSocket, line: string, handle: RequestHandler): Promise<void> {
	let request: WireRequest;
	try {
		request = wireRequestSchema.parse(JSON.parse(line));
	} catch {
		reply(socket, { id: "", ...brokerErr("bad_request", "request is not a JSON-RPC line {id, method, params}") });
		return;
	}
	let result: BrokerResult<unknown>;
	try {
		result = await handle(request.method, request.params);
	} catch (error) {
		result = brokerErr("cdp_protocol", `handler threw: ${String(error)}`);
	}
	reply(socket, { id: request.id, ...result });
}

/** True when something accepts connections on `path`. */
function listening(path: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const settle = (value: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => settle(false), PROBE_TIMEOUT_MS);
		Bun.connect({
			unix: path,
			socket: {
				open(socket) {
					socket.end();
					settle(true);
				},
				data() {},
				error() {
					settle(false);
				},
				connectError() {
					settle(false);
				},
			},
		}).catch(() => settle(false));
	});
}

/**
 * Serve newline-delimited JSON-RPC on a Unix socket: each line `{id, method, params}` is answered by one line
 * `{id, success, data | error}`, in completion order, so requests on one connection may overlap. A socket file
 * left behind by a dead process is removed; one that is live is an error.
 */
export async function serveBroker(socketPath: string, handle: RequestHandler): Promise<BrokerResult<BrokerServer>> {
	if (existsSync(socketPath)) {
		if (await listening(socketPath)) {
			return brokerErr("devtools_unavailable", `a broker is already listening on ${socketPath}`);
		}
		try {
			unlinkSync(socketPath);
		} catch (error) {
			return brokerErr("io_failed", `cannot remove stale socket ${socketPath}: ${String(error)}`);
		}
	}
	const open = new Set<ServerSocket>();
	let listener: SocketListener<ServerData>;
	try {
		listener = Bun.listen<ServerData>({
			unix: socketPath,
			socket: {
				open(socket) {
					socket.data = { buffer: "", decoder: new TextDecoder(), pending: Buffer.alloc(0), closed: false };
					open.add(socket);
				},
				data(socket, chunk) {
					const data = socket.data;
					data.buffer += data.decoder.decode(chunk, { stream: true });
					if (data.buffer.length > MAX_REQUEST_BYTES) {
						reply(socket, { id: "", ...brokerErr("bad_request", "request line is too long") });
						socket.end();
						return;
					}
					for (let nl = data.buffer.indexOf("\n"); nl >= 0; nl = data.buffer.indexOf("\n")) {
						const line = data.buffer.slice(0, nl).trim();
						data.buffer = data.buffer.slice(nl + 1);
						if (line !== "") void answer(socket, line, handle);
					}
				},
				drain(socket) {
					flush(socket);
				},
				close(socket) {
					socket.data.closed = true;
					open.delete(socket);
				},
				error(socket) {
					socket.data.closed = true;
					open.delete(socket);
				},
			},
		});
	} catch (error) {
		return brokerErr("io_failed", `cannot listen on ${socketPath}: ${String(error)}`);
	}
	return {
		success: true,
		data: {
			socketPath,
			async close() {
				listener.stop(true);
				for (const socket of [...open]) {
					socket.data.closed = true;
					socket.end();
				}
				open.clear();
				try {
					unlinkSync(socketPath);
				} catch {
					// already gone
				}
			},
		},
	};
}

export type CallOptions = {
	/** give up after this long (default 15 s, or the request's own `timeoutMs` plus 5 s) */
	timeoutMs?: number;
};

const replySchema = z.looseObject({ id: z.string(), success: z.boolean() });

let callCounter = 0;

function timeoutOf(request: BrokerRequest, options: CallOptions): number {
	if (options.timeoutMs !== undefined) return options.timeoutMs;
	const params = request.params;
	if (typeof params === "object" && params !== null && "timeoutMs" in params && typeof params.timeoutMs === "number") {
		return params.timeoutMs + TIMEOUT_MARGIN_MS;
	}
	return DEFAULT_CALL_TIMEOUT_MS;
}

/**
 * One request to the broker listening on `socketPath`. `broker_unreachable` when nothing listens (no dev
 * session, or it ended), `timeout` when no reply came in time; otherwise the handler's own result.
 */
export function callBroker<R extends BrokerRequest>(
	socketPath: string,
	request: R,
	options: CallOptions = {}
): Promise<BrokerResult<ResponseOf<R>>> {
	const id = `${process.pid}-${++callCounter}`;
	const timeoutMs = timeoutOf(request, options);
	return new Promise((resolve) => {
		let settled = false;
		let buffer = "";
		const decoder = new TextDecoder();
		let current: Socket<undefined> | undefined;
		const settle = (result: BrokerResult<unknown>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			current?.end();
			resolve(result as BrokerResult<ResponseOf<R>>);
		};
		const timer = setTimeout(
			() => settle(brokerErr("timeout", `broker did not answer ${request.method} within ${timeoutMs} ms`)),
			timeoutMs
		);
		const unreachable = (why: string) =>
			settle(
				brokerErr(
					"broker_unreachable",
					`no broker at ${socketPath} (${why})`,
					"start `warden dev`; the broker lives as long as the dev session"
				)
			);
		const line = `${JSON.stringify({ id, method: request.method, params: request.params ?? {} })}\n`;
		Bun.connect<undefined>({
			unix: socketPath,
			socket: {
				open(socket) {
					current = socket;
					socket.write(line);
				},
				data(_socket, chunk) {
					buffer += decoder.decode(chunk, { stream: true });
					for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
						const text = buffer.slice(0, nl);
						buffer = buffer.slice(nl + 1);
						let parsed: unknown;
						try {
							parsed = JSON.parse(text);
						} catch {
							continue;
						}
						const head = replySchema.safeParse(parsed);
						if (!head.success || (head.data.id !== id && head.data.id !== "")) continue;
						const { id: _id, ...result } = head.data;
						settle(result as BrokerResult<unknown>);
						return;
					}
				},
				close() {
					unreachable("connection closed before a reply");
				},
				error(_socket, error) {
					unreachable(error.message);
				},
				connectError(_socket, error) {
					unreachable(error.message);
				},
			},
		}).catch((error: unknown) => unreachable(String(error)));
	});
}
