import { unlinkSync } from "node:fs";
import type { Driver, DriverError, DriverResult, Logger } from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import { LineSplitter } from "@delacour/warden-driver/helper/simd-protocol";
import {
	APP_OPS,
	type AppOp,
	DRIVER_OPS,
	type DriverOp,
	type LocalAlertIn,
	OPTIONAL_OPS,
	type OptionalOp,
	REMOTE_PROTOCOL,
	type ReadyEvent,
	type RemoteResponse,
	remoteWire,
	requestSchema,
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

/**
 * Serve `driver` on a unix socket (see `remote-protocol.ts`). Every connection gets a `ready` event; ops from all of
 * them run one at a time, in arrival order, so two `warden ui` calls never interleave on one device. A thrown driver
 * error becomes `E_INTERNAL`. The socket file is replaced if one is there and removed by `stop`.
 */
export class DriverServer implements RemoteServer {
	readonly socketPath: string;
	private readonly conns = new Set<Conn>();
	private readonly outboxes = new WeakMap<Conn, Outbox>();
	private readonly splitters = new WeakMap<object, LineSplitter>();
	private readonly encoder = new TextEncoder();
	private chain: Promise<unknown> = Promise.resolve();
	private inFlight = 0;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;
	private listener: ReturnType<typeof Bun.listen> | undefined;

	constructor(private readonly options: ServeDriverOptions) {
		this.socketPath = options.socketPath;
	}

	/** Starts listening; resolves with this server once the socket is up. */
	async start(): Promise<DriverServer> {
		try {
			unlinkSync(this.socketPath);
		} catch {
			// not there
		}
		this.listener = Bun.listen({
			unix: this.socketPath,
			socket: {
				open: (socket) => {
					this.conns.add(socket);
					this.outboxes.set(socket, { queued: new Uint8Array(0) });
					this.splitters.set(socket, new LineSplitter());
					this.armIdle();
					this.send(socket, this.ready());
				},
				data: (socket, chunk) => {
					const splitter = this.splitters.get(socket);
					if (splitter === undefined) return;
					for (const line of splitter.push(chunk)) this.onLine(socket, line);
				},
				drain: (socket) => {
					this.flush(socket);
				},
				close: (socket) => {
					this.conns.delete(socket);
					this.armIdle();
				},
				error: (socket) => {
					this.conns.delete(socket);
					this.armIdle();
				},
			},
		});
		this.armIdle();
		return this;
	}

	readonly drop = (): void => {
		for (const conn of [...this.conns]) {
			this.conns.delete(conn);
			try {
				conn.end();
			} catch {
				// already gone
			}
		}
	};

	readonly stop = async (): Promise<void> => {
		if (this.stopped) return;
		this.stopped = true;
		if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
		this.listener?.stop(true);
		this.drop();
		await Promise.race([this.chain, Bun.sleep(this.options.stopWaitMs ?? 5000)]);
		if (this.options.closeDriver !== false) await this.options.driver.close();
		try {
			unlinkSync(this.socketPath);
		} catch {
			// already gone
		}
	};

	private armIdle(): void {
		if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		const idleMs = this.options.idleMs ?? 0;
		if (idleMs <= 0 || this.stopped || this.conns.size > 0 || this.inFlight > 0) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			if (!this.stopped && this.conns.size === 0 && this.inFlight === 0) this.options.onIdle?.();
		}, idleMs);
	}

	private ready(): ReadyEvent {
		const { driver, alertIn } = this.options;
		return {
			event: "ready",
			protocol: REMOTE_PROTOCOL,
			platform: driver.platform,
			id: driver.id,
			pid: process.pid,
			capabilities: driver.capabilities,
			optional: OPTIONAL_OPS.filter((op) => this.methodOf(driver, op) !== undefined),
			...(alertIn !== undefined ? { alertIn } : {}),
		};
	}

	private flush(conn: Conn): void {
		const box = this.outboxes.get(conn);
		if (box === undefined || box.queued.length === 0) return;
		try {
			const written = conn.write(box.queued);
			box.queued = written >= box.queued.length ? new Uint8Array(0) : box.queued.slice(Math.max(written, 0));
		} catch (error) {
			this.options.log?.(`remote: write failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private send(conn: Conn, message: unknown): void {
		const box = this.outboxes.get(conn);
		if (!this.conns.has(conn) || box === undefined) return;
		const bytes = this.encoder.encode(`${JSON.stringify(message)}\n`);
		const merged = new Uint8Array(box.queued.length + bytes.length);
		merged.set(box.queued, 0);
		merged.set(bytes, box.queued.length);
		box.queued = merged;
		this.flush(conn);
	}

	private async run(op: string, args: readonly unknown[]): DriverResult<unknown> {
		const { driver, log } = this.options;
		if (op === "ping") return { success: true, data: { pid: process.pid } };
		if (op === "shutdown") {
			queueMicrotask(() => this.options.onShutdown?.());
			return { success: true, data: null };
		}
		const method = this.resolve(driver, op);
		if (method === undefined) return this.badRequest(`the served driver has no \`${op}\``);
		try {
			const result = await method(...remoteWire.argsFromWire(args));
			return result.success ? { success: true, data: this.toWire(op, result.data) } : result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log?.(`remote: ${op} threw: ${message}`);
			return { success: false, error: driverErrors.make("E_INTERNAL", `${op} threw: ${message}`) };
		}
	}

	private onLine(conn: Conn, line: string): void {
		const { log, driver } = this.options;
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
		if (!remoteWire.isRemoteOp(op)) {
			this.send(conn, { id, result: this.badRequest(`unknown op \`${op}\``) } satisfies RemoteResponse);
			return;
		}
		this.inFlight += 1;
		this.armIdle();
		const next = this.chain.then(async () => {
			const result = await this.run(op, args);
			this.send(conn, { id, result, capabilities: driver.capabilities } satisfies RemoteResponse);
		});
		this.chain = next.catch(() => undefined);
		void next.finally(() => {
			this.inFlight -= 1;
			this.armIdle();
		});
	}

	private methodOf(target: object, name: string): Callable | undefined {
		const value: unknown = Reflect.get(target, name);
		return typeof value === "function" ? (value.bind(target) as Callable) : undefined;
	}

	private isDriverOp(op: string): op is DriverOp {
		return (DRIVER_OPS as readonly string[]).includes(op);
	}

	private isOptionalOp(op: string): op is OptionalOp {
		return (OPTIONAL_OPS as readonly string[]).includes(op);
	}

	private isAppOp(op: string): op is AppOp {
		return (APP_OPS as readonly string[]).includes(op);
	}

	private badRequest(message: string): { success: false; error: DriverError } {
		return { success: false, error: driverErrors.make("E_BAD_REQUEST", message) };
	}

	/** The served driver's method for `op`, or undefined when it has none. */
	private resolve(driver: Driver, op: string): Callable | undefined {
		if (op.startsWith("app.")) {
			const name = op.slice(4);
			return this.isAppOp(name) ? this.methodOf(driver.app, name) : undefined;
		}
		if (this.isDriverOp(op) || this.isOptionalOp(op)) return this.methodOf(driver, op);
		return undefined;
	}

	/** What crosses the wire for `op`'s data: snapshots without `flat`, screenshots as base64. */
	private toWire(op: string, data: unknown): unknown {
		if (data === undefined || data === null || typeof data !== "object") return data;
		if (op === "snapshot" && "elements" in data && "flat" in data) {
			return remoteWire.snapshotToWire(data as Parameters<typeof remoteWire.snapshotToWire>[0]);
		}
		if (op === "screenshot")
			return remoteWire.screenshotToWire(data as Parameters<typeof remoteWire.screenshotToWire>[0]);
		return data;
	}
}
