import type { Result } from "@delacour/warden-types/result";
import type { DriverError, DriverResult, Logger } from "../driver.types";
import { driverError } from "../errors";
import {
	encodeRequest,
	type FatalEvent,
	hasOpSchema,
	type LogEvent,
	mapWireError,
	type OpData,
	opSchemas,
	parseLine,
	protocolVersion,
	type ReadyEvent,
	type SimdEvent,
	type SimdMessage,
	type SimdResponse,
} from "./simd-protocol";
import {
	type SimdSpawn,
	socketTransport,
	stdioTransport,
	type Transport,
	type TransportClose,
	type TransportFactory,
} from "./simd-transport";

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

function crashed(info: TransportClose | undefined, what: string): DriverError {
	const exit = info?.exitCode === null || info?.exitCode === undefined ? "" : ` (exit ${info.exitCode})`;
	const tail = info?.stderrTail.length ? `: ${info.stderrTail.slice(-3).join(" | ")}` : "";
	return driverError("E_HELPER_CRASHED", `warden-simd ${what}${exit}${tail}`, {
		detail: info ? { exitCode: info.exitCode, stderrTail: info.stderrTail } : undefined,
	});
}

/** Shared client engine; the transport decides stdio vs socket. */
export async function createSimdClient(
	factory: TransportFactory,
	options: ClientOptions = {}
): Promise<Result<SimdClient, DriverError>> {
	const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const maxRespawns = options.maxRespawns ?? 0;
	const shutdownOnClose = options.shutdownOnClose ?? false;
	const log = options.log;

	const pending = new Map<string, Pending>();
	const listeners = new Map<keyof SimdEventMap, Set<Listener>>();
	let seq = 0;
	let respawns = 0;
	let closed = false;
	let closing = false;
	/** the helper already acknowledged `shutdown`, so `close()` need not ask again */
	let shutdownAcked = false;
	let current: Session | undefined;
	let opening: Promise<Result<Session, DriverError>> | undefined;
	/** why the last session died, when it was not a fatal */
	let lastCrash: DriverError | undefined;
	/** sticky: a `fatal` is not retried (the device is the problem, not the process) */
	let fatalError: DriverError | undefined;

	function emit<E extends keyof SimdEventMap>(event: E, payload: SimdEventMap[E]): void {
		for (const listener of listeners.get(event) ?? []) {
			try {
				listener(payload);
			} catch (error) {
				log?.(`[simd] ${event} listener threw: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	function failAll(error: DriverError): void {
		for (const [id, entry] of pending) {
			clearTimeout(entry.timer);
			pending.delete(id);
			entry.resolve({ success: false, error });
		}
	}

	function handleResponse(response: SimdResponse): void {
		// any answer proves the (re)spawned helper works: the respawn budget is per crash window
		respawns = 0;
		const entry = pending.get(response.id);
		if (!entry) {
			log?.(`[simd] response for unknown id ${response.id} (timed out?)`);
			return;
		}
		clearTimeout(entry.timer);
		pending.delete(response.id);
		entry.resolve(
			response.ok
				? { success: true, data: response.data ?? null }
				: { success: false, error: mapWireError(response.error) }
		);
	}

	function handleFatal(session: Session, event: FatalEvent): void {
		const error = mapWireError(event.error);
		fatalError = error;
		log?.(`[simd] fatal: ${error.code}: ${error.message}`);
		emit("fatal", error);
		if (session.handshaking) {
			session.handshaking = false;
			session.handshake({ success: false, error });
		}
		failAll(error);
	}

	function handleEvent(session: Session, event: SimdEvent): void {
		if (event.event === "log") {
			log?.(`[simd] ${event.level}: ${event.message}`);
			emit("log", event);
		} else if (event.event === "fatal") {
			handleFatal(session, event);
		} else if (session.handshaking) {
			session.handshaking = false;
			session.ready = event;
			emit("ready", event);
			session.handshake({ success: true, data: event });
		}
	}

	function handleMessage(session: Session, message: SimdMessage): void {
		if (message.kind === "response") handleResponse(message.response);
		else handleEvent(session, message.event);
	}

	function handleLine(session: Session, line: string): void {
		const parsed = parseLine(line);
		if (!parsed.success) {
			log?.(`[simd] ignoring line (${parsed.reason}): ${line.slice(0, 200)}`);
			return;
		}
		handleMessage(session, parsed.message);
	}

	function handleClose(session: Session, info: TransportClose): void {
		if (!session.alive) return;
		session.alive = false;
		const expected = closed || closing;
		emit("exit", { exitCode: info.exitCode, expected });
		if (session.handshaking) {
			session.handshaking = false;
			session.handshake({ success: false, error: fatalError ?? crashed(info, "exited before it was ready") });
			return;
		}
		if (fatalError) return;
		const error = crashed(info, expected ? "stopped" : "exited unexpectedly");
		if (!expected) lastCrash = error;
		failAll(expected ? driverError("E_INTERNAL", "client closed", { retryable: false }) : error);
	}

	async function openSession(): Promise<Result<Session, DriverError>> {
		let resolveHandshake: (result: Result<ReadyEvent, DriverError>) => void = () => undefined;
		const handshake = new Promise<Result<ReadyEvent, DriverError>>((resolve) => {
			resolveHandshake = resolve;
		});
		const session: Session = { alive: true, handshake: resolveHandshake, handshaking: true };
		const stderrTail: string[] = [];
		const opened = await factory({
			onLine: (line) => handleLine(session, line),
			onDiagnostic: (line) => {
				stderrTail.push(line);
				if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
				log?.(`[simd:stderr] ${line}`);
			},
			onClose: (info) =>
				handleClose(session, { ...info, stderrTail: info.stderrTail.length ? info.stderrTail : [...stderrTail] }),
		});
		if (!opened.success) return opened;
		session.transport = opened.data;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<Result<ReadyEvent, DriverError>>((resolve) => {
			timer = setTimeout(
				() =>
					resolve({
						success: false,
						error: driverError("E_TIMEOUT", `warden-simd sent no ready event within ${readyTimeoutMs} ms`),
					}),
				readyTimeoutMs
			);
		});
		const ready = await Promise.race([handshake, timeout]);
		clearTimeout(timer);
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
				error: driverError(
					"E_INTERNAL",
					`warden-simd speaks protocol ${ready.data.protocol}, this client expects ${protocolVersion}; rebuild or reinstall the helper`,
					{ retryable: false }
				),
			};
		}
		current = session;
		return { success: true, data: session };
	}

	async function ensureSession(): Promise<Result<Session, DriverError>> {
		if (current?.alive) return { success: true, data: current };
		if (opening) return opening;
		if (respawns >= maxRespawns) {
			return {
				success: false,
				error: lastCrash ?? driverError("E_HELPER_CRASHED", "warden-simd connection is closed"),
			};
		}
		respawns += 1;
		log?.(`[simd] respawning helper (${respawns}/${maxRespawns})`);
		opening = openSession().finally(() => {
			opening = undefined;
		});
		return opening;
	}

	function validate(op: string, data: unknown): Result<unknown, DriverError> {
		if (!hasOpSchema(op)) return { success: true, data };
		const parsed = opSchemas[op].safeParse(data);
		if (parsed.success) return { success: true, data: parsed.data };
		return {
			success: false,
			error: driverError(
				"E_INTERNAL",
				`warden-simd returned an unexpected \`${op}\` payload: ${parsed.error.message}`,
				{
					retryable: false,
				}
			),
		};
	}

	async function request(
		op: string,
		params: Record<string, unknown>,
		opts: RequestOptions
	): Promise<Result<unknown, DriverError>> {
		if (closed)
			return { success: false, error: driverError("E_INTERNAL", "warden-simd client is closed", { retryable: false }) };
		if (fatalError) return { success: false, error: fatalError };
		const session = await ensureSession();
		if (!session.success) return session;
		const transport = session.data.transport;
		if (!transport) return { success: false, error: driverError("E_INTERNAL", "warden-simd transport missing") };
		const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
		const id = String(++seq);
		const result = await new Promise<Result<unknown, DriverError>>((resolve) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				resolve({
					success: false,
					error: driverError("E_TIMEOUT", `warden-simd \`${op}\` timed out after ${timeoutMs} ms`, {
						detail: { op, timeoutMs },
					}),
				});
			}, timeoutMs);
			pending.set(id, { op, resolve, timer });
			try {
				transport.send(encodeRequest({ timeoutMs, ...params, id, op }));
			} catch (error) {
				clearTimeout(timer);
				pending.delete(id);
				resolve({
					success: false,
					error: crashed(
						undefined,
						`rejected the \`${op}\` request: ${error instanceof Error ? error.message : String(error)}`
					),
				});
			}
		});
		if (result.success && op === "shutdown") shutdownAcked = true;
		return result.success ? validate(op, result.data) : result;
	}

	const first = await openSession();
	if (!first.success) return first;

	const client: SimdClient = {
		get ready() {
			const ready = current?.ready ?? first.data.ready;
			if (!ready) throw new Error("warden-simd client has no handshake");
			return ready;
		},
		request: (<Op extends string>(op: Op, params: Record<string, unknown> = {}, opts: RequestOptions = {}) =>
			request(op, params, opts) as DriverResult<OpData<Op>>) as SimdClient["request"],
		on(event, handler) {
			const set = listeners.get(event) ?? new Set<Listener>();
			set.add(handler as Listener);
			listeners.set(event, set);
			return () => {
				set.delete(handler as Listener);
			};
		},
		async close() {
			if (closed) return;
			closing = true;
			const session = current;
			if (shutdownOnClose && session?.alive && !fatalError && !shutdownAcked) {
				await request("shutdown", {}, { timeoutMs: SHUTDOWN_TIMEOUT_MS });
			}
			closed = true;
			failAll(driverError("E_INTERNAL", "warden-simd client closed", { retryable: false }));
			await session?.transport?.close().catch(() => undefined);
		},
	};
	return { success: true, data: client };
}

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

/** Stdio mode: own a helper process for this client (by-hand runs). Crashes are retried by one respawn. */
export function spawnSimd(options: SpawnSimdOptions): Promise<Result<SimdClient, DriverError>> {
	const cmd = [
		options.helperPath,
		"--udid",
		options.udid,
		...(options.resources ? ["--resources", options.resources] : []),
		...(options.args ?? []),
	];
	return createSimdClient(stdioTransport({ cmd, spawn: options.spawn, graceMs: options.graceMs }), {
		...options,
		maxRespawns: options.maxRespawns ?? 1,
		shutdownOnClose: options.shutdownOnClose ?? true,
	});
}

export type ConnectSimdOptions = ClientOptions & { socketPath: string };

/** Socket mode: attach to a running (pre-warmed) helper daemon. `close()` only disconnects; the daemon idles out. */
export function connectSimd(options: ConnectSimdOptions): Promise<Result<SimdClient, DriverError>> {
	return createSimdClient(socketTransport({ socketPath: options.socketPath }), {
		...options,
		maxRespawns: options.maxRespawns ?? 0,
		shutdownOnClose: options.shutdownOnClose ?? false,
	});
}
