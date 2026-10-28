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
	type LocalAlertIn,
	OPTIONAL_OPS,
	type OptionalOp,
	REMOTE_PROTOCOL,
	type ReadyEvent,
	type RemoteResponse,
	requestSchema,
	screenshotToWire,
	snapshotToWire,
} from "./remote-protocol";

export type ServeDriverOptions = {
	driver: Driver;
	socketPath: string;
	/** call `onIdle` once no client has been connected and no op has run for this long; absent or 0 = never */
	idleMs?: number;
	onIdle?: () => void;
	/** a client asked for `shutdown` (it was acknowledged first) */
	onShutdown?: () => void;
	/** how long `stop()` waits for the op in flight before it goes on (default 5000) */
	stopWaitMs?: number;
	/** close the driver on `stop()` (default true) */
	closeDriver?: boolean;
	/** tell clients to answer `alertIn` themselves this way */
	alertIn?: LocalAlertIn;
	log?: Logger;
};

export type RemoteServer = {
	socketPath: string;
	/** stop listening, drop every client, wait for the op in flight, close the driver (unless `closeDriver: false`) */
	stop(): Promise<void>;
	/** tests: drop every connection at once, as a crash would, without answering what is in flight */
	drop(): void;
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

/** What crosses the wire for `op`'s data: snapshots without `flat`, screenshots as base64. */
function toWire(op: string, data: unknown): unknown {
	if (data === undefined || data === null || typeof data !== "object") return data;
	if (op === "snapshot" && "elements" in data && "flat" in data) {
		return snapshotToWire(data as Parameters<typeof snapshotToWire>[0]);
	}
	if (op === "screenshot") return screenshotToWire(data as Parameters<typeof screenshotToWire>[0]);
	return data;
}

/**
 * Serve `driver` on a unix socket (see `remote-protocol.ts`). Every connection gets a `ready` event; ops from all of
 * them run one at a time, in arrival order, so two `warden ui` calls never interleave on one device. A thrown driver
 * error becomes `E_INTERNAL`. The socket file is replaced if one is there and removed by `stop`.
 */
export async function serveDriver(options: ServeDriverOptions): Promise<RemoteServer> {
	const { driver, socketPath, log } = options;
	const conns = new Set<Conn>();
	const outboxes = new WeakMap<Conn, Outbox>();
	const encoder = new TextEncoder();
	let chain: Promise<unknown> = Promise.resolve();
	let inFlight = 0;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	const armIdle = () => {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		idleTimer = undefined;
		const idleMs = options.idleMs ?? 0;
		if (idleMs <= 0 || stopped || conns.size > 0 || inFlight > 0) return;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			if (!stopped && conns.size === 0 && inFlight === 0) options.onIdle?.();
		}, idleMs);
	};

	const ready = (): ReadyEvent => ({
		event: "ready",
		protocol: REMOTE_PROTOCOL,
		platform: driver.platform,
		id: driver.id,
		pid: process.pid,
		capabilities: driver.capabilities,
		optional: OPTIONAL_OPS.filter((op) => methodOf(driver, op) !== undefined),
		...(options.alertIn !== undefined ? { alertIn: options.alertIn } : {}),
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
		const method = resolve(driver, op);
		if (method === undefined) return badRequest(`the served driver has no \`${op}\``);
		try {
			const result = await method(...argsFromWire(args));
			return result.success ? { success: true, data: toWire(op, result.data) } : result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log?.(`remote: ${op} threw: ${message}`);
			return { success: false, error: driverError("E_INTERNAL", `${op} threw: ${message}`) };
		}
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
		armIdle();
		const next = chain.then(async () => {
			const result = await run(op, args);
			send(conn, { id, result, capabilities: driver.capabilities } satisfies RemoteResponse);
		});
		chain = next.catch(() => undefined);
		void next.finally(() => {
			inFlight -= 1;
			armIdle();
		});
	};

	try {
		unlinkSync(socketPath);
	} catch {
		// not there
	}
	const splitters = new WeakMap<object, ReturnType<typeof createLineSplitter>>();
	const listener = Bun.listen({
		unix: socketPath,
		socket: {
			open(socket) {
				conns.add(socket);
				outboxes.set(socket, { queued: new Uint8Array(0) });
				splitters.set(socket, createLineSplitter());
				armIdle();
				send(socket, ready());
			},
			data(socket, chunk) {
				const splitter = splitters.get(socket);
				if (splitter === undefined) return;
				for (const line of splitter.push(chunk)) onLine(socket, line);
			},
			drain(socket) {
				flush(socket);
			},
			close(socket) {
				conns.delete(socket);
				armIdle();
			},
			error(socket) {
				conns.delete(socket);
				armIdle();
			},
		},
	});
	armIdle();

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
		socketPath,
		drop,
		async stop() {
			if (stopped) return;
			stopped = true;
			if (idleTimer !== undefined) clearTimeout(idleTimer);
			listener.stop(true);
			drop();
			await Promise.race([chain, Bun.sleep(options.stopWaitMs ?? 5000)]);
			if (options.closeDriver !== false) await driver.close();
			try {
				unlinkSync(socketPath);
			} catch {
				// already gone
			}
		},
	};
}
