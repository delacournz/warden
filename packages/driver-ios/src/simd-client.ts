import type { DriverError, DriverResult, Logger } from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import {
	type FatalEvent,
	type LogEvent,
	type OpData,
	opSchemas,
	protocolVersion,
	type ReadyEvent,
	type SimdEvent,
	type SimdMessage,
	type SimdResponse,
	simdProtocol,
} from "@delacour/warden-driver/helper/simd-protocol";
import {
	type SimdSpawn,
	simdTransports,
	type Transport,
	type TransportClose,
	type TransportFactory,
} from "@delacour/warden-driver/helper/simd-transport";
import type { Result } from "@delacour/warden-types/result";

/**
 * NDJSON client for `warden-simd`, over the helper's stdio (`spawnSimd`, by-hand runs) or its unix
 * socket (`connectSimd`, the pre-warmed daemon). Multiplexes requests by id (responses may arrive out
 * of order), enforces per-op timeouts, forwards `log` events, maps `fatal` to a `DriverError`, and in
 * stdio mode respawns the helper on the call after a crash.
 */

export type SimdEventMap = {
	ready: ReadyEvent;
	log: LogEvent;
	/** the helper reported it cannot continue (also fails every in-flight request) */
	fatal: DriverError;
	/** the helper process / connection went away */
	exit: { exitCode: number | null; expected: boolean };
};

export type RequestOptions = { timeoutMs?: number };

export type SimdClient = {
	/** the handshake of the current helper process (refreshed after a respawn) */
	readonly ready: ReadyEvent;
	request<Op extends string>(op: Op, params?: Record<string, unknown>, opts?: RequestOptions): DriverResult<OpData<Op>>;
	/** subscribe; returns the unsubscribe function */
	on<E extends keyof SimdEventMap>(event: E, handler: (payload: SimdEventMap[E]) => void): () => void;
	close(): Promise<void>;
};

export type ClientOptions = {
	log?: Logger;
	/** default per-request timeout, 10 s */
	defaultTimeoutMs?: number;
	/** how long to wait for `ready`, 15 s */
	readyTimeoutMs?: number;
	/**
	 * respawns allowed in a row after unexpected exits (stdio default 1, socket 0). The budget refills
	 * as soon as the helper answers anything, so each crash gets one respawn but a helper that dies
	 * before answering is not retried forever.
	 */
	maxRespawns?: number;
	/** ask the helper to `shutdown` on close (stdio: yes; a shared socket daemon: no) */
	shutdownOnClose?: boolean;
};

export type SpawnSimdOptions = ClientOptions & {
	helperPath: string;
	udid: string;
	/** `--resources <dir>`: where the in-sim AX bridge guest lives */
	resources?: string;
	/** extra helper arguments after the standard ones (e.g. `--hid indigo`) */
	args?: readonly string[];
	/** injectable process spawn (tests); defaults to `Bun.spawn` */
	spawn?: SimdSpawn;
	/** grace period for `close()` before the helper is killed */
	graceMs?: number;
};

export type ConnectSimdOptions = ClientOptions & { socketPath: string };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 500;
const STDERR_TAIL = 20;

type Pending = {
	op: string;
	resolve: (result: Result<unknown, DriverError>) => void;
	timer: ReturnType<typeof setTimeout>;
};

type Session = {
	transport?: Transport;
	ready?: ReadyEvent;
	alive: boolean;
	handshake: (result: Result<ReadyEvent, DriverError>) => void;
	handshaking: boolean;
};

type Listener = (payload: SimdEventMap[keyof SimdEventMap]) => void;

/** One `SimdClient`: the multiplexing engine behind a transport factory. Built through {@link SimdClients}. */
class SimdClientEngine implements SimdClient {
	private readonly defaultTimeoutMs: number;
	private readonly readyTimeoutMs: number;
	private readonly maxRespawns: number;
	private readonly shutdownOnClose: boolean;
	private readonly log: Logger | undefined;

	private readonly pending = new Map<string, Pending>();
	private readonly listeners = new Map<keyof SimdEventMap, Set<Listener>>();
	private seq = 0;
	private respawns = 0;
	private closed = false;
	private closing = false;
	/** the helper already acknowledged `shutdown`, so `close()` need not ask again */
	private shutdownAcked = false;
	private current: Session | undefined;
	private opening: Promise<Result<Session, DriverError>> | undefined;
	/** why the last session died, when it was not a fatal */
	private lastCrash: DriverError | undefined;
	/** sticky: a `fatal` is not retried (the device is the problem, not the process) */
	private fatalError: DriverError | undefined;
	private firstReady: ReadyEvent | undefined;

	constructor(
		private readonly factory: TransportFactory,
		options: ClientOptions
	) {
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		this.maxRespawns = options.maxRespawns ?? 0;
		this.shutdownOnClose = options.shutdownOnClose ?? false;
		this.log = options.log;
	}

	get ready(): ReadyEvent {
		const ready = this.current?.ready ?? this.firstReady;
		if (!ready) throw new Error("warden-simd client has no handshake");
		return ready;
	}

	// `request` is the untyped engine: `validate` parses each op's data against `opSchemas` at run time, so
	// narrowing the result to `OpData<Op>` here is the one place the static op map is trusted.
	request = ((op: string, params: Record<string, unknown> = {}, opts: RequestOptions = {}) =>
		this.send(op, params, opts)) as SimdClient["request"];

	on<E extends keyof SimdEventMap>(event: E, handler: (payload: SimdEventMap[E]) => void): () => void {
		// `listeners` stores every handler as the payload union; `emit` only ever passes `event`'s own payload, so
		// widening the per-event handler on the way in is safe.
		const stored = handler as Listener;
		const set = this.listeners.get(event) ?? new Set<Listener>();
		set.add(stored);
		this.listeners.set(event, set);
		return () => {
			set.delete(stored);
		};
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closing = true;
		const session = this.current;
		if (this.shutdownOnClose && session?.alive && !this.fatalError && !this.shutdownAcked) {
			await this.send("shutdown", {}, { timeoutMs: SHUTDOWN_TIMEOUT_MS });
		}
		this.closed = true;
		this.failAll(driverErrors.make("E_INTERNAL", "warden-simd client closed", { retryable: false }));
		await session?.transport?.close().catch(() => undefined);
	}

	/** Open the first session; the client is only handed out once the helper has said `ready`. */
	async open(): Promise<Result<SimdClient, DriverError>> {
		const first = await this.openSession();
		if (!first.success) return first;
		this.firstReady = first.data.ready;
		return { success: true, data: this };
	}

	private crashed(info: TransportClose | undefined, what: string): DriverError {
		const exit = info?.exitCode === null || info?.exitCode === undefined ? "" : ` (exit ${info.exitCode})`;
		const tail = info?.stderrTail.length ? `: ${info.stderrTail.slice(-3).join(" | ")}` : "";
		return driverErrors.make("E_HELPER_CRASHED", `warden-simd ${what}${exit}${tail}`, {
			detail: info ? { exitCode: info.exitCode, stderrTail: info.stderrTail } : undefined,
		});
	}

	private emit<E extends keyof SimdEventMap>(event: E, payload: SimdEventMap[E]): void {
		for (const listener of this.listeners.get(event) ?? []) {
			try {
				listener(payload);
			} catch (error) {
				this.log?.(`[simd] ${event} listener threw: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	private failAll(error: DriverError): void {
		for (const [id, entry] of this.pending) {
			clearTimeout(entry.timer);
			this.pending.delete(id);
			entry.resolve({ success: false, error });
		}
	}

	private handleResponse(response: SimdResponse): void {
		// any answer proves the (re)spawned helper works: the respawn budget is per crash window
		this.respawns = 0;
		const entry = this.pending.get(response.id);
		if (!entry) {
			this.log?.(`[simd] response for unknown id ${response.id} (timed out?)`);
			return;
		}
		clearTimeout(entry.timer);
		this.pending.delete(response.id);
		entry.resolve(
			response.ok
				? { success: true, data: response.data ?? null }
				: { success: false, error: simdProtocol.mapWireError(response.error) }
		);
	}

	private handleFatal(session: Session, event: FatalEvent): void {
		const error = simdProtocol.mapWireError(event.error);
		this.fatalError = error;
		this.log?.(`[simd] fatal: ${error.code}: ${error.message}`);
		this.emit("fatal", error);
		if (session.handshaking) {
			session.handshaking = false;
			session.handshake({ success: false, error });
		}
		this.failAll(error);
	}

	private handleEvent(session: Session, event: SimdEvent): void {
		if (event.event === "log") {
			this.log?.(`[simd] ${event.level}: ${event.message}`);
			this.emit("log", event);
		} else if (event.event === "fatal") {
			this.handleFatal(session, event);
		} else if (session.handshaking) {
			session.handshaking = false;
			session.ready = event;
			this.emit("ready", event);
			session.handshake({ success: true, data: event });
		}
	}

	private handleMessage(session: Session, message: SimdMessage): void {
		if (message.kind === "response") this.handleResponse(message.response);
		else this.handleEvent(session, message.event);
	}

	private handleLine(session: Session, line: string): void {
		const parsed = simdProtocol.parseLine(line);
		if (!parsed.success) {
			this.log?.(`[simd] ignoring line (${parsed.reason}): ${line.slice(0, 200)}`);
			return;
		}
		this.handleMessage(session, parsed.message);
	}

	private handleClose(session: Session, info: TransportClose): void {
		if (!session.alive) return;
		session.alive = false;
		const expected = this.closed || this.closing;
		this.emit("exit", { exitCode: info.exitCode, expected });
		if (session.handshaking) {
			session.handshaking = false;
			session.handshake({
				success: false,
				error: this.fatalError ?? this.crashed(info, "exited before it was ready"),
			});
			return;
		}
		if (this.fatalError) return;
		const error = this.crashed(info, expected ? "stopped" : "exited unexpectedly");
		if (!expected) this.lastCrash = error;
		this.failAll(expected ? driverErrors.make("E_INTERNAL", "client closed", { retryable: false }) : error);
	}

	private async openSession(): Promise<Result<Session, DriverError>> {
		let resolveHandshake: (result: Result<ReadyEvent, DriverError>) => void = () => undefined;
		const handshake = new Promise<Result<ReadyEvent, DriverError>>((resolve) => {
			resolveHandshake = resolve;
		});
		const session: Session = { alive: true, handshake: resolveHandshake, handshaking: true };
		const stderrTail: string[] = [];
		const opened = await this.factory({
			onLine: (line) => this.handleLine(session, line),
			onDiagnostic: (line) => {
				stderrTail.push(line);
				if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
				this.log?.(`[simd:stderr] ${line}`);
			},
			onClose: (info) =>
				this.handleClose(session, { ...info, stderrTail: info.stderrTail.length ? info.stderrTail : [...stderrTail] }),
		});
		if (!opened.success) return opened;
		session.transport = opened.data;
		const ready = await this.awaitReady(handshake);
		if (!ready.success) {
			session.handshaking = false;
			session.alive = false;
			await session.transport.close().catch(() => undefined);
			return ready;
		}
		if (ready.data.protocol !== protocolVersion) {
			session.alive = false;
			await session.transport.close().catch(() => undefined);
			return {
				success: false,
				error: driverErrors.make(
					"E_INTERNAL",
					`warden-simd speaks protocol ${ready.data.protocol}, this client expects ${protocolVersion}; rebuild or reinstall the helper`,
					{ retryable: false }
				),
			};
		}
		this.current = session;
		return { success: true, data: session };
	}

	private async awaitReady(
		handshake: Promise<Result<ReadyEvent, DriverError>>
	): Promise<Result<ReadyEvent, DriverError>> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<Result<ReadyEvent, DriverError>>((resolve) => {
			timer = setTimeout(
				() =>
					resolve({
						success: false,
						error: driverErrors.make("E_TIMEOUT", `warden-simd sent no ready event within ${this.readyTimeoutMs} ms`),
					}),
				this.readyTimeoutMs
			);
		});
		const ready = await Promise.race([handshake, timeout]);
		clearTimeout(timer);
		return ready;
	}

	private async ensureSession(): Promise<Result<Session, DriverError>> {
		if (this.current?.alive) return { success: true, data: this.current };
		if (this.opening) return this.opening;
		if (this.respawns >= this.maxRespawns) {
			return {
				success: false,
				error: this.lastCrash ?? driverErrors.make("E_HELPER_CRASHED", "warden-simd connection is closed"),
			};
		}
		this.respawns += 1;
		this.log?.(`[simd] respawning helper (${this.respawns}/${this.maxRespawns})`);
		this.opening = this.openSession().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	private validate(op: string, data: unknown): Result<unknown, DriverError> {
		if (!simdProtocol.hasOpSchema(op)) return { success: true, data };
		const parsed = opSchemas[op].safeParse(data);
		if (parsed.success) return { success: true, data: parsed.data };
		return {
			success: false,
			error: driverErrors.make(
				"E_INTERNAL",
				`warden-simd returned an unexpected \`${op}\` payload: ${parsed.error.message}`,
				{
					retryable: false,
				}
			),
		};
	}

	private async send(
		op: string,
		params: Record<string, unknown>,
		opts: RequestOptions
	): Promise<Result<unknown, DriverError>> {
		if (this.closed)
			return {
				success: false,
				error: driverErrors.make("E_INTERNAL", "warden-simd client is closed", { retryable: false }),
			};
		if (this.fatalError) return { success: false, error: this.fatalError };
		const session = await this.ensureSession();
		if (!session.success) return session;
		const transport = session.data.transport;
		if (!transport) return { success: false, error: driverErrors.make("E_INTERNAL", "warden-simd transport missing") };
		const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
		const id = String(++this.seq);
		const result = await new Promise<Result<unknown, DriverError>>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({
					success: false,
					error: driverErrors.make("E_TIMEOUT", `warden-simd \`${op}\` timed out after ${timeoutMs} ms`, {
						detail: { op, timeoutMs },
					}),
				});
			}, timeoutMs);
			this.pending.set(id, { op, resolve, timer });
			try {
				transport.send(simdProtocol.encodeRequest({ timeoutMs, ...params, id, op }));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				resolve({
					success: false,
					error: this.crashed(
						undefined,
						`rejected the \`${op}\` request: ${error instanceof Error ? error.message : String(error)}`
					),
				});
			}
		});
		if (result.success && op === "shutdown") this.shutdownAcked = true;
		return result.success ? this.validate(op, result.data) : result;
	}
}

/** Builds {@link SimdClient}s. Use the shared {@link simdClients} singleton. */
export class SimdClients {
	/** Shared client engine; the transport decides stdio vs socket. */
	create(factory: TransportFactory, options: ClientOptions = {}): Promise<Result<SimdClient, DriverError>> {
		return new SimdClientEngine(factory, options).open();
	}

	/** Stdio mode: own a helper process for this client (by-hand runs). Crashes are retried by one respawn. */
	spawn(options: SpawnSimdOptions): Promise<Result<SimdClient, DriverError>> {
		const cmd = [
			options.helperPath,
			"--udid",
			options.udid,
			...(options.resources ? ["--resources", options.resources] : []),
			...(options.args ?? []),
		];
		return this.create(simdTransports.stdio({ cmd, spawn: options.spawn, graceMs: options.graceMs }), {
			...options,
			maxRespawns: options.maxRespawns ?? 1,
			shutdownOnClose: options.shutdownOnClose ?? true,
		});
	}

	/** Socket mode: attach to a running (pre-warmed) helper daemon. `close()` only disconnects; the daemon idles out. */
	connect(options: ConnectSimdOptions): Promise<Result<SimdClient, DriverError>> {
		return this.create(simdTransports.socket({ socketPath: options.socketPath }), {
			...options,
			maxRespawns: options.maxRespawns ?? 0,
			shutdownOnClose: options.shutdownOnClose ?? false,
		});
	}
}

export const simdClients = new SimdClients();
