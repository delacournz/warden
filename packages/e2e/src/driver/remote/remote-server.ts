import { unlinkSync } from "node:fs";
import type { Driver, DriverError, DriverResult, Logger } from "../driver.types";
import { driverError } from "../errors";
import { createLineSplitter } from "../ios/simd-protocol";
import {
	APP_OPS,
	type AppOp,
	argsFromWire,
	DRIVER_OPS,
	type DriverOp,
	isRemoteOp,
	isStreamOp,
	type LocalAlertIn,
	OPTIONAL_OPS,
	type OptionalOp,
	REMOTE_PROTOCOL,
	type ReadyEvent,
	type RemoteResponse,
	requestSchema,
	screenshotToWire,
	snapshotFromWire,
	snapshotToWire,
	type WireSnapshot,
} from "./remote-protocol";

/** What every served driver takes, whatever carries the bytes. */
type ServiceOptions = {
	driver: Driver;
	/** a client asked for `shutdown` (it was acknowledged first) */
	onShutdown?: () => void;
	/** how long `stop()` waits for the op in flight before it goes on (default 5000) */
	stopWaitMs?: number;
	/** close the driver on `stop()` (default true) */
	closeDriver?: boolean;
	/** tell clients to answer `alertIn` themselves this way */
	alertIn?: LocalAlertIn;
	/** answers `stream.*` (`remote-protocol.ts` `STREAM_OPS`); absent = they are `E_UNSUPPORTED` */
	stream?: StreamService;
	log?: Logger;
};

/** The device's live video behind `stream.*`; replies are the iOS helper's shapes. */
export type StreamService = {
	start(params: Record<string, unknown>): DriverResult<unknown>;
	keyframe(): DriverResult<unknown>;
	stats(): DriverResult<unknown>;
	stop(): DriverResult<unknown>;
};

async function runStreamOp(
	stream: StreamService | undefined,
	op: string,
	args: readonly unknown[]
): DriverResult<unknown> {
	if (stream === undefined) {
		return { success: false, error: driverError("E_UNSUPPORTED", `this host serves no stream (\`${op}\`)`) };
	}
	try {
		switch (op) {
			case "stream.start": {
				const params = args[0];
				const record = params !== null && typeof params === "object" ? (params as Record<string, unknown>) : {};
				return await stream.start(record);
			}
			case "stream.keyframe":
				return await stream.keyframe();
			case "stream.stats":
				return await stream.stats();
			default:
				return await stream.stop();
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { success: false, error: driverError("E_INTERNAL", `${op} threw: ${message}`) };
	}
}

export type ServeDriverOptions = ServiceOptions & {
	socketPath: string;
	/** call `onIdle` once no client has been connected and no op has run for this long; absent or 0 = never */
	idleMs?: number;
	onIdle?: () => void;
};

export type RemoteServer = {
	socketPath: string;
	/** stop listening, drop every client, wait for the op in flight, close the driver (unless `closeDriver: false`) */
	stop(): Promise<void>;
	/** tests: drop every connection at once, as a crash would, without answering what is in flight */
	drop(): void;
};

/** One client on a byte stream: requests arrive on `input`, replies go to `write` (the process's stdin / stdout). */
export type ServeDriverStdioOptions = ServiceOptions & {
	input: ReadableStream<Uint8Array>;
	/** takes every byte it is given (a stdout writer); never partial */
	write: (bytes: Uint8Array) => void;
};

export type StdioDriverServer = {
	/** resolves when `input` ends (the client went away) or a client asked for `shutdown` */
	finished: Promise<void>;
	/** wait for the op in flight, close the driver (unless `closeDriver: false`) */
	stop(): Promise<void>;
};

type Conn = { write(data: Uint8Array): number; end(): void };

/**
 * Bytes a connection has not taken yet. A socket write can be partial (it returns how much it took), and a snapshot
 * reply is tens of KB, so the rest waits here for `drain`.
 */
type Outbox = { queued: Uint8Array };

type Callable = (...args: unknown[]) => DriverResult<unknown>;

function methodOf(target: object, name: string): Callable | undefined {
	const value: unknown = Reflect.get(target, name);
	return typeof value === "function" ? (value.bind(target) as Callable) : undefined;
}

function isDriverOp(op: string): op is DriverOp {
	return (DRIVER_OPS as readonly string[]).includes(op);
}

function isOptionalOp(op: string): op is OptionalOp {
	return (OPTIONAL_OPS as readonly string[]).includes(op);
}

function isAppOp(op: string): op is AppOp {
	return (APP_OPS as readonly string[]).includes(op);
}

function badRequest(message: string): { success: false; error: DriverError } {
	return { success: false, error: driverError("E_BAD_REQUEST", message) };
}

/** The served driver's method for `op`, or undefined when it has none. */
function resolve(driver: Driver, op: string): Callable | undefined {
	if (op.startsWith("app.")) {
		const name = op.slice(4);
		return isAppOp(name) ? methodOf(driver.app, name) : undefined;
	}
	if (isDriverOp(op) || isOptionalOp(op)) return methodOf(driver, op);
	return undefined;
}

/** Call a served `method` for `op` with wire `args`; its data goes back in wire form. */
async function invoke(method: Callable, op: string, args: readonly unknown[]): DriverResult<unknown> {
	const wireArgs = argsFromWire(args);
	// readA11y takes and returns a snapshot, which crosses the wire without `flat`
	if (op === "readA11y" && wireArgs[0] !== undefined) wireArgs[0] = snapshotFromWire(wireArgs[0] as WireSnapshot);
	const result = await method(...wireArgs);
	// auditNatively answers a plain NativeAuditResult (a missing engine is `skipped`, never an error)
	if (op === "auditNatively") return { success: true, data: result };
	return result.success ? { success: true, data: toWire(op, result.data) } : result;
}

/** What crosses the wire for `op`'s data: snapshots without `flat`, screenshots as base64. */
function toWire(op: string, data: unknown): unknown {
	if (data === undefined || data === null || typeof data !== "object") return data;
	if ((op === "snapshot" || op === "readA11y") && "elements" in data && "flat" in data) {
		return snapshotToWire(data as Parameters<typeof snapshotToWire>[0]);
	}
	if (op === "screenshot") return screenshotToWire(data as Parameters<typeof screenshotToWire>[0]);
	return data;
}

/** Run one driver op for the wire: arguments from the wire, the result to it; a throw is `E_INTERNAL`. */
async function runDriverOp(
	driver: Driver,
	op: string,
	args: readonly unknown[],
	log: Logger | undefined
): DriverResult<unknown> {
	const method = resolve(driver, op);
	if (method === undefined) return badRequest(`the served driver has no \`${op}\``);
	try {
		return await invoke(method, op, args);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log?.(`remote: ${op} threw: ${message}`);
		return { success: false, error: driverError("E_INTERNAL", `${op} threw: ${message}`) };
	}
}

type DriverService = {
	open(conn: Conn): void;
	data(conn: Conn, chunk: Uint8Array): void;
	drain(conn: Conn): void;
	close(conn: Conn): void;
	/** live connections */
	readonly size: number;
	/** ops queued or running */
	readonly inFlight: number;
	drop(): void;
	/** drop every client, wait for the op in flight (up to `stopWaitMs`), close the driver */
	stop(): Promise<void>;
};

/**
 * The protocol core every transport shares: a `ready` event per connection, ops from all connections run one at a
 * time in arrival order (two `warden ui` calls never interleave on one device), a thrown driver error is `E_INTERNAL`.
 * `onActivity` fires whenever a connection or an op starts or ends (the socket server's idle timer).
 */
function driverService(options: ServiceOptions, onActivity: () => void = () => undefined): DriverService {
	const { driver, log } = options;
	const conns = new Set<Conn>();
	const outboxes = new WeakMap<Conn, Outbox>();
	const splitters = new WeakMap<Conn, ReturnType<typeof createLineSplitter>>();
	const encoder = new TextEncoder();
	let chain: Promise<unknown> = Promise.resolve();
	let inFlight = 0;

	const ready = (): ReadyEvent => ({
		event: "ready",
		protocol: REMOTE_PROTOCOL,
		platform: driver.platform,
		id: driver.id,
		pid: process.pid,
		capabilities: driver.capabilities,
		optional: OPTIONAL_OPS.filter((op) => methodOf(driver, op) !== undefined),
		...(options.alertIn !== undefined ? { alertIn: options.alertIn } : {}),
		...(options.stream !== undefined ? { stream: true as const } : {}),
	});

	const flush = (conn: Conn) => {
		const box = outboxes.get(conn);
		if (box === undefined || box.queued.length === 0) return;
		try {
			const written = conn.write(box.queued);
			box.queued = written >= box.queued.length ? new Uint8Array(0) : box.queued.slice(Math.max(written, 0));
		} catch (error) {
			log?.(`remote: write failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const send = (conn: Conn, message: unknown) => {
		const box = outboxes.get(conn);
		if (!conns.has(conn) || box === undefined) return;
		const bytes = encoder.encode(`${JSON.stringify(message)}\n`);
		const merged = new Uint8Array(box.queued.length + bytes.length);
		merged.set(box.queued, 0);
		merged.set(bytes, box.queued.length);
		box.queued = merged;
		flush(conn);
	};

	const run = async (op: string, args: readonly unknown[]): DriverResult<unknown> => {
		if (op === "ping") return { success: true, data: { pid: process.pid } };
		if (op === "shutdown") {
			queueMicrotask(() => options.onShutdown?.());
			return { success: true, data: null };
		}
		return runDriverOp(driver, op, args, log);
	};

	const onLine = (conn: Conn, line: string) => {
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			log?.("remote: dropped a line that is not JSON");
			return;
		}
		const parsed = requestSchema.safeParse(raw);
		if (!parsed.success) {
			log?.("remote: dropped a malformed request");
			return;
		}
		const { id, op, args } = parsed.data;
		if (!isRemoteOp(op)) {
			send(conn, { id, result: badRequest(`unknown op \`${op}\``) } satisfies RemoteResponse);
			return;
		}
		inFlight += 1;
		onActivity();
		if (isStreamOp(op)) {
			// beside the driver chain: a keyframe request must not wait for a tap
			void runStreamOp(options.stream, op, args)
				.then((result) => send(conn, { id, result, capabilities: driver.capabilities } satisfies RemoteResponse))
				.finally(() => {
					inFlight -= 1;
					onActivity();
				});
			return;
		}
		const next = chain.then(async () => {
			const result = await run(op, args);
			send(conn, { id, result, capabilities: driver.capabilities } satisfies RemoteResponse);
		});
		chain = next.catch(() => undefined);
		void next.finally(() => {
			inFlight -= 1;
			onActivity();
		});
	};

	const drop = () => {
		for (const conn of [...conns]) {
			conns.delete(conn);
			try {
				conn.end();
			} catch {
				// already gone
			}
		}
	};

	return {
		open(conn) {
			conns.add(conn);
			outboxes.set(conn, { queued: new Uint8Array(0) });
			splitters.set(conn, createLineSplitter());
			onActivity();
			send(conn, ready());
		},
		data(conn, chunk) {
			const splitter = splitters.get(conn);
			if (splitter === undefined) return;
			for (const line of splitter.push(chunk)) onLine(conn, line);
		},
		drain: flush,
		close(conn) {
			conns.delete(conn);
			onActivity();
		},
		get size() {
			return conns.size;
		},
		get inFlight() {
			return inFlight;
		},
		drop,
		async stop() {
			drop();
			if (options.stream !== undefined) await runStreamOp(options.stream, "stream.stop", []);
			await Promise.race([chain, Bun.sleep(options.stopWaitMs ?? 5000)]);
			if (options.closeDriver !== false) await driver.close();
		},
	};
}

/**
 * Serve `driver` on a unix socket (see `remote-protocol.ts`): `driverService` per connection. The socket file is
 * replaced if one is there and removed by `stop`.
 */
export async function serveDriver(options: ServeDriverOptions): Promise<RemoteServer> {
	const { socketPath } = options;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	const armIdle = () => {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		idleTimer = undefined;
		const idleMs = options.idleMs ?? 0;
		if (idleMs <= 0 || stopped || service.size > 0 || service.inFlight > 0) return;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			if (!stopped && service.size === 0 && service.inFlight === 0) options.onIdle?.();
		}, idleMs);
	};
	const service = driverService(options, () => armIdle());

	try {
		unlinkSync(socketPath);
	} catch {
		// not there
	}
	const listener = Bun.listen({
		unix: socketPath,
		socket: {
			open: (socket) => service.open(socket),
			data: (socket, chunk) => service.data(socket, chunk),
			drain: (socket) => service.drain(socket),
			close: (socket) => service.close(socket),
			error: (socket) => service.close(socket),
		},
	});
	armIdle();

	return {
		socketPath,
		drop: () => service.drop(),
		async stop() {
			if (stopped) return;
			stopped = true;
			if (idleTimer !== undefined) clearTimeout(idleTimer);
			listener.stop(true);
			await service.stop();
			try {
				unlinkSync(socketPath);
			} catch {
				// already gone
			}
		},
	};
}

/**
 * Serve `driver` to the one client on the other end of a byte stream: `warden __driver-serve` on its stdin / stdout,
 * reached through `ssh` by `connectRemoteDriver({ transport: stdioTransport(…) })`. Same protocol and `ready`
 * handshake as the socket server; `finished` resolves when the input ends or the client asks for `shutdown`.
 */
export function serveDriverStdio(options: ServeDriverStdioOptions): StdioDriverServer {
	let finish: () => void = () => undefined;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const service = driverService({
		...options,
		onShutdown: () => {
			options.onShutdown?.();
			finish();
		},
	});
	const conn: Conn = {
		write(data) {
			options.write(data);
			return data.length;
		},
		end: () => finish(),
	};
	service.open(conn);
	void (async () => {
		const reader = options.input.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				service.data(conn, value);
			}
		} catch {
			// the pipe broke: the client is gone
		}
		finish();
	})();
	let stopped: Promise<void> | undefined;
	return {
		finished,
		stop() {
			stopped ??= (async () => {
				finish();
				await service.stop();
			})();
			return stopped;
		},
	};
}
