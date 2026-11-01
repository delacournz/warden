import type { DriverError, DriverResult, Logger } from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import { simdProtocol } from "@delacour/warden-driver/helper/simd-protocol";
import {
	type SimdSpawn,
	simdTransports,
	type Transport,
	type TransportClose,
} from "@delacour/warden-driver/helper/simd-transport";
import type { Result } from "@delacour/warden-types/result";
import {
	settleDataSchema,
	textDataSchema,
	UIAD_PROTOCOL,
	type UiadEvent,
	type UiadHealth,
	type UiadResponse,
	type UiadSettleData,
	type UiadSnapshotData,
	type UiadTextData,
	uiadProtocol,
} from "./uiad-protocol";

/**
 * Client of `warden-uiad`, the resident UiAutomation server (`packages/driver-android/native/`), over the stdio of an `adb shell`
 * that runs it. Starts it and waits for `ready`, sends one request at a time per op in order (the server answers in
 * order), enforces a timeout per request, forwards `log` events, and maps `fatal`, a crash and a protocol mismatch to
 * a `DriverError`. A timed-out request kills the server (what it was doing is unknowable); the driver starts a new one.
 */

export type UiadClient = {
	/** what the server said about itself in `ready` */
	readonly health: UiadHealth;
	/** false once the server has exited, been killed, or timed out */
	alive(): boolean;
	request(op: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): DriverResult<unknown>;
	snapshot(params?: SnapshotParams, opts?: { timeoutMs?: number }): DriverResult<UiadSnapshotData>;
	settle(params: { quietMs: number; timeoutMs: number }): DriverResult<UiadSettleData>;
	typeText(text: string): DriverResult<UiadTextData>;
	/** called once, if the server dies without `close()` having been asked for */
	onDeath(handler: (info: TransportClose) => void): void;
	/** `shutdown`, then close stdin, then kill when it lingers. Safe to call twice. */
	close(): Promise<void>;
};

export type SnapshotParams = {
	scope?: "active" | "all";
	maxNodes?: number;
	/** wait for this long without accessibility events before reading (the dump's built-in idle wait) */
	idleMs?: number;
	rootWaitMs?: number;
	/** false keeps nodes the user cannot see, flagged `invisible` */
	skipInvisible?: boolean;
	/** false may answer from the server's node cache (2-3 ms), which can lag the app by an event */
	fresh?: boolean;
	windows?: boolean;
};

export type UiadStartOptions = {
	/** the host command that runs the server on the device (`adb -s <serial> shell exec env CLASSPATH=... app_process / ...`) */
	cmd: readonly string[];
	spawn?: SimdSpawn;
	log?: Logger;
	/** how long to wait for `ready`, default 5 s (a start takes 80-450 ms, the long end on a busy host) */
	readyTimeoutMs?: number;
	/** default per-request timeout, default 10 s */
	requestTimeoutMs?: number;
	/** how long `close()` waits for the server to exit after closing stdin, default 1 s */
	graceMs?: number;
};

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_GRACE_MS = 1_000;
const SHUTDOWN_WAIT_MS = 300;
const NOT_SENT = { sent: false };

type Pending = {
	op: string;
	resolve: (result: Result<unknown, DriverError>) => void;
	timer: ReturnType<typeof setTimeout>;
};

type Handshake = Result<UiadHealth, DriverError>;

type Read<T> = (data: unknown) => { ok: true; value: T } | { ok: false; reason: string };

/** Readers for replies: a zod schema or the hand-written snapshot check. */
class UiadReaders {
	/** A reader for a reply checked by a zod schema. */
	schema<T>(schema: {
		safeParse(data: unknown): { success: true; data: T } | { success: false; error: { message: string } };
	}): Read<T> {
		return (data) => {
			const parsed = schema.safeParse(data);
			return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: parsed.error.message };
		};
	}

	readonly snapshot: Read<UiadSnapshotData> = (data) => {
		const value = uiadProtocol.readSnapshotData(data);
		return typeof value === "string" ? { ok: false, reason: value } : { ok: true, value };
	};
}

const uiadReaders = new UiadReaders();

/** A live `warden-uiad` server behind a transport: the pending requests, the death handlers and the handshake. */
class UiadConnection implements UiadClient {
	health!: UiadHealth;
	private readonly pending = new Map<string, Pending>();
	private readonly deathHandlers: Array<(info: TransportClose) => void> = [];
	private seq = 0;
	private isAlive = true;
	private closing = false;
	private transport: Transport | undefined;
	private settleHandshake: (result: Handshake) => void = () => undefined;
	private handshaken = false;
	private readonly log: Logger | undefined;
	private readonly requestTimeoutMs: number;
	private readonly readyTimeoutMs: number;

	constructor(private readonly options: UiadStartOptions) {
		this.log = options.log;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	}

	/** Start the server and wait for `ready`; the failure says why (busy slot, protocol, crash, timeout). */
	async start(): DriverResult<UiadClient> {
		const factory = simdTransports.stdio({
			cmd: this.options.cmd,
			...(this.options.spawn ? { spawn: this.options.spawn } : { spawn: simdTransports.spawn }),
			graceMs: this.options.graceMs ?? DEFAULT_GRACE_MS,
		});
		const waiting = new Promise<Handshake>((resolve) => {
			this.settleHandshake = (result) => {
				if (this.handshaken) return;
				this.handshaken = true;
				resolve(result);
			};
		});
		const opened = await factory({
			onLine: this.onLine,
			onDiagnostic: (line) => this.log?.(`uiad stderr: ${line}`),
			onClose: this.onClose,
		});
		if (!opened.success) return opened;
		const transport = opened.data;
		this.transport = transport;
		const timer = setTimeout(
			() =>
				this.settleHandshake({
					success: false,
					error: driverErrors.make("E_TIMEOUT", `warden-uiad sent no ready event within ${this.readyTimeoutMs}ms`),
				}),
			this.readyTimeoutMs
		);
		const ready = await waiting;
		clearTimeout(timer);
		if (!ready.success) {
			this.isAlive = false;
			this.closing = true;
			await transport.close().catch(() => undefined);
			return ready;
		}
		this.health = ready.data;
		return { success: true, data: this };
	}

	alive(): boolean {
		return this.isAlive;
	}

	request(op: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): DriverResult<unknown> {
		return new Promise((resolve) => {
			const transport = this.transport;
			if (!this.isAlive || transport === undefined) {
				resolve({
					success: false,
					error: driverErrors.make("E_HELPER_CRASHED", "warden-uiad is not running", { detail: NOT_SENT }),
				});
				return;
			}
			const id = String(++this.seq);
			const entry: Pending = {
				op,
				resolve,
				timer: this.requestTimer(id, op, opts.timeoutMs ?? this.requestTimeoutMs, resolve),
			};
			this.pending.set(id, entry);
			try {
				transport.send(simdProtocol.encodeRequest({ ...params, id, op }));
			} catch (error) {
				clearTimeout(entry.timer);
				this.pending.delete(id);
				resolve({
					success: false,
					error: driverErrors.make(
						"E_HELPER_CRASHED",
						`cannot write to warden-uiad: ${error instanceof Error ? error.message : String(error)}`,
						{ detail: NOT_SENT }
					),
				});
			}
		});
	}

	async snapshot(params: SnapshotParams = {}, opts: { timeoutMs?: number } = {}): DriverResult<UiadSnapshotData> {
		return this.through(await this.request("snapshot", { ...params }, opts), uiadReaders.snapshot, "snapshot");
	}

	async settle(params: { quietMs: number; timeoutMs: number }): DriverResult<UiadSettleData> {
		// the server waits up to `timeoutMs` itself; the request timer only has to outlast that
		return this.through(
			await this.request("settle", params, { timeoutMs: params.timeoutMs + this.requestTimeoutMs }),
			uiadReaders.schema(settleDataSchema),
			"settle"
		);
	}

	async typeText(text: string): DriverResult<UiadTextData> {
		return this.through(await this.request("typeText", { text }), uiadReaders.schema(textDataSchema), "typeText");
	}

	onDeath(handler: (info: TransportClose) => void): void {
		this.deathHandlers.push(handler);
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		if (this.isAlive && this.transport !== undefined) {
			this.isAlive = false;
			const transport = this.transport;
			const bye = new Promise<void>((resolve) => {
				this.pending.set("shutdown", {
					op: "shutdown",
					resolve: () => resolve(),
					timer: setTimeout(resolve, SHUTDOWN_WAIT_MS),
				});
			});
			try {
				transport.send(simdProtocol.encodeRequest({ id: "shutdown", op: "shutdown" }));
				await bye;
			} catch {
				// stdin already closed
			}
		}
		this.failAll(driverErrors.make("E_HELPER_CRASHED", "warden-uiad was closed"));
		await this.transport?.close().catch(() => undefined);
	}

	/** A reply's data, checked: a server that answers with something unexpected is a bug worth naming, not a crash. */
	private through<T>(result: Result<unknown, DriverError>, read: Read<T>, op: string): Result<T, DriverError> {
		if (!result.success) return result;
		const checked = read(result.data);
		return checked.ok
			? { success: true, data: checked.value }
			: {
					success: false,
					error: driverErrors.make("E_INTERNAL", `warden-uiad \`${op}\` reply is malformed: ${checked.reason}`),
				};
	}

	private requestTimer(
		id: string,
		op: string,
		timeoutMs: number,
		resolve: (result: Result<unknown, DriverError>) => void
	): ReturnType<typeof setTimeout> {
		return setTimeout(() => {
			this.pending.delete(id);
			const error = driverErrors.make("E_TIMEOUT", `warden-uiad did not answer \`${op}\` within ${timeoutMs}ms`);
			resolve({ success: false, error });
			// what it was doing is unknowable: end it, the next call starts a fresh one
			this.isAlive = false;
			this.failAll(error);
			void this.transport?.close().catch(() => undefined);
		}, timeoutMs);
	}

	private exitMessage(info: TransportClose): string {
		const exit = info.exitCode === null ? "" : ` (exit ${info.exitCode})`;
		const tail = info.stderrTail.length > 0 ? `: ${info.stderrTail.slice(-3).join(" | ")}` : "";
		return `warden-uiad exited${exit}${tail}`;
	}

	private failAll(error: DriverError): void {
		for (const [id, entry] of this.pending) {
			clearTimeout(entry.timer);
			this.pending.delete(id);
			entry.resolve({ success: false, error });
		}
	}

	private onEvent(event: UiadEvent): void {
		if (event.event === "log") {
			this.log?.(`uiad ${event.level}: ${event.message}`);
		} else if (event.event === "ready") {
			this.settleHandshake(
				event.protocol === UIAD_PROTOCOL
					? { success: true, data: event.data }
					: {
							success: false,
							error: driverErrors.make(
								"E_UNSUPPORTED",
								`warden-uiad speaks protocol ${event.protocol}, this client speaks ${UIAD_PROTOCOL}`
							),
						}
			);
		} else {
			const error = simdProtocol.mapWireError(event.error);
			this.settleHandshake({ success: false, error });
			this.failAll(error);
		}
	}

	private onResponse(response: UiadResponse): void {
		const entry = this.pending.get(response.id);
		if (!entry) {
			this.log?.(`uiad: reply to nothing (id ${response.id})`);
			return;
		}
		clearTimeout(entry.timer);
		this.pending.delete(response.id);
		entry.resolve(
			response.ok
				? { success: true, data: response.data }
				: { success: false, error: simdProtocol.mapWireError(response.error) }
		);
	}

	private readonly onLine = (line: string): void => {
		const parsed = uiadProtocol.parseUiadLine(line);
		if (!parsed.success) {
			this.log?.(`uiad: ignoring a line (${parsed.reason}): ${line.slice(0, 120)}`);
		} else if (parsed.message.kind === "event") {
			this.onEvent(parsed.message.event);
		} else {
			this.onResponse(parsed.message.response);
		}
	};

	private readonly onClose = (info: TransportClose): void => {
		const wasAlive = this.isAlive;
		this.isAlive = false;
		const crash = driverErrors.make("E_HELPER_CRASHED", this.exitMessage(info), {
			detail: { exitCode: info.exitCode, stderrTail: info.stderrTail },
		});
		this.settleHandshake({ success: false, error: crash });
		this.failAll(crash);
		if (wasAlive && !this.closing) for (const handler of this.deathHandlers) handler(info);
	};
}

/** Starts `warden-uiad` clients and classifies their errors. */
export class UiadClients {
	/** Start the server and wait for `ready`; the failure says why (busy slot, protocol, crash, timeout). */
	async startUiad(options: UiadStartOptions): DriverResult<UiadClient> {
		return new UiadConnection(options).start();
	}

	/** True when the request never reached the server (it was already gone), so the call can be made again without doubling its effect. */
	neverSent(error: DriverError): boolean {
		const detail: unknown = error.detail;
		return typeof detail === "object" && detail !== null && "sent" in detail && detail.sent === false;
	}

	/** True when `error` is the server saying another UiAutomation client holds the device. */
	isBusy(error: DriverError): boolean {
		const detail: unknown = error.detail;
		return (
			error.code === "E_AX_UNAVAILABLE" &&
			typeof detail === "object" &&
			detail !== null &&
			"reason" in detail &&
			detail.reason === "uiautomation_busy"
		);
	}
}

export const uiadClients = new UiadClients();
