import type { Result } from "@delacour/warden-types/result";
import type { DriverError, DriverResult, Logger } from "../driver.types";
import { driverError } from "../errors";
import { encodeRequest, mapWireError } from "../ios/simd-protocol";
import { bunSpawn, type SimdSpawn, stdioTransport, type Transport, type TransportClose } from "../ios/simd-transport";
import {
	parseUiadLine,
	readSnapshotData,
	settleDataSchema,
	textDataSchema,
	UIAD_PROTOCOL,
	type UiadEvent,
	type UiadHealth,
	type UiadResponse,
	type UiadSettleData,
	type UiadSnapshotData,
	type UiadTextData,
} from "./uiad-protocol";

/**
 * Client of `warden-uiad`, the resident UiAutomation server (`native/android/`), over the stdio of an `adb shell`
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

/** A reader for a reply checked by a zod schema. */
function schemaReader<T>(schema: {
	safeParse(data: unknown): { success: true; data: T } | { success: false; error: { message: string } };
}): Read<T> {
	return (data) => {
		const parsed = schema.safeParse(data);
		return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: parsed.error.message };
	};
}

const readSnapshot: Read<UiadSnapshotData> = (data) => {
	const value = readSnapshotData(data);
	return typeof value === "string" ? { ok: false, reason: value } : { ok: true, value };
};

/** A reply's data, checked: a server that answers with something unexpected is a bug worth naming, not a crash. */
function through<T>(result: Result<unknown, DriverError>, read: Read<T>, op: string): Result<T, DriverError> {
	if (!result.success) return result;
	const checked = read(result.data);
	return checked.ok
		? { success: true, data: checked.value }
		: {
				success: false,
				error: driverError("E_INTERNAL", `warden-uiad \`${op}\` reply is malformed: ${checked.reason}`),
			};
}

function exitMessage(info: TransportClose): string {
	const exit = info.exitCode === null ? "" : ` (exit ${info.exitCode})`;
	const tail = info.stderrTail.length > 0 ? `: ${info.stderrTail.slice(-3).join(" | ")}` : "";
	return `warden-uiad exited${exit}${tail}`;
}

/** Start the server and wait for `ready`; the failure says why (busy slot, protocol, crash, timeout). */
export async function startUiad(options: UiadStartOptions): DriverResult<UiadClient> {
	const { log } = options;
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const pending = new Map<string, Pending>();
	const deathHandlers: Array<(info: TransportClose) => void> = [];
	let seq = 0;
	let alive = true;
	let closing = false;
	let transport: Transport | undefined;
	let settleHandshake: (result: Handshake) => void = () => undefined;
	let handshaken = false;

	const failAll = (error: DriverError): void => {
		for (const [id, entry] of pending) {
			clearTimeout(entry.timer);
			pending.delete(id);
			entry.resolve({ success: false, error });
		}
	};

	const onEvent = (event: UiadEvent): void => {
		if (event.event === "log") {
			log?.(`uiad ${event.level}: ${event.message}`);
		} else if (event.event === "ready") {
			settleHandshake(
				event.protocol === UIAD_PROTOCOL
					? { success: true, data: event.data }
					: {
							success: false,
							error: driverError(
								"E_UNSUPPORTED",
								`warden-uiad speaks protocol ${event.protocol}, this client speaks ${UIAD_PROTOCOL}`
							),
						}
			);
		} else {
			const error = mapWireError(event.error);
			settleHandshake({ success: false, error });
			failAll(error);
		}
	};

	const onResponse = (response: UiadResponse): void => {
		const entry = pending.get(response.id);
		if (!entry) {
			log?.(`uiad: reply to nothing (id ${response.id})`);
			return;
		}
		clearTimeout(entry.timer);
		pending.delete(response.id);
		entry.resolve(
			response.ok ? { success: true, data: response.data } : { success: false, error: mapWireError(response.error) }
		);
	};

	const onLine = (line: string): void => {
		const parsed = parseUiadLine(line);
		if (!parsed.success) {
			log?.(`uiad: ignoring a line (${parsed.reason}): ${line.slice(0, 120)}`);
		} else if (parsed.message.kind === "event") {
			onEvent(parsed.message.event);
		} else {
			onResponse(parsed.message.response);
		}
	};

	const onClose = (info: TransportClose): void => {
		const wasAlive = alive;
		alive = false;
		const crash = driverError("E_HELPER_CRASHED", exitMessage(info), {
			detail: { exitCode: info.exitCode, stderrTail: info.stderrTail },
		});
		settleHandshake({ success: false, error: crash });
		failAll(crash);
		if (wasAlive && !closing) for (const handler of deathHandlers) handler(info);
	};

	const factory = stdioTransport({
		cmd: options.cmd,
		...(options.spawn ? { spawn: options.spawn } : { spawn: bunSpawn }),
		graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
	});
	const waiting = new Promise<Handshake>((resolve) => {
		settleHandshake = (result) => {
			if (handshaken) return;
			handshaken = true;
			resolve(result);
		};
	});
	const opened = await factory({
		onLine,
		onDiagnostic: (line) => log?.(`uiad stderr: ${line}`),
		onClose,
	});
	if (!opened.success) return opened;
	transport = opened.data;
	const timer = setTimeout(
		() =>
			settleHandshake({
				success: false,
				error: driverError("E_TIMEOUT", `warden-uiad sent no ready event within ${readyTimeoutMs}ms`),
			}),
		readyTimeoutMs
	);
	const ready = await waiting;
	clearTimeout(timer);
	if (!ready.success) {
		alive = false;
		closing = true;
		await transport.close().catch(() => undefined);
		return ready;
	}

	const request: UiadClient["request"] = (op, params = {}, opts = {}) =>
		new Promise((resolve) => {
			if (!alive || transport === undefined) {
				resolve({
					success: false,
					error: driverError("E_HELPER_CRASHED", "warden-uiad is not running", { detail: NOT_SENT }),
				});
				return;
			}
			const id = String(++seq);
			const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
			const entry: Pending = {
				op,
				resolve,
				timer: setTimeout(() => {
					pending.delete(id);
					const error = driverError("E_TIMEOUT", `warden-uiad did not answer \`${op}\` within ${timeoutMs}ms`);
					resolve({ success: false, error });
					// what it was doing is unknowable: end it, the next call starts a fresh one
					alive = false;
					failAll(error);
					void transport?.close().catch(() => undefined);
				}, timeoutMs),
			};
			pending.set(id, entry);
			try {
				transport.send(encodeRequest({ ...params, id, op }));
			} catch (error) {
				clearTimeout(entry.timer);
				pending.delete(id);
				resolve({
					success: false,
					error: driverError(
						"E_HELPER_CRASHED",
						`cannot write to warden-uiad: ${error instanceof Error ? error.message : String(error)}`,
						{ detail: NOT_SENT }
					),
				});
			}
		});

	return {
		success: true,
		data: {
			health: ready.data,
			alive: () => alive,
			request,
			async snapshot(params = {}, opts = {}) {
				return through(await request("snapshot", { ...params }, opts), readSnapshot, "snapshot");
			},
			async settle(params) {
				// the server waits up to `timeoutMs` itself; the request timer only has to outlast that
				return through(
					await request("settle", params, { timeoutMs: params.timeoutMs + requestTimeoutMs }),
					schemaReader(settleDataSchema),
					"settle"
				);
			},
			async typeText(text) {
				return through(await request("typeText", { text }), schemaReader(textDataSchema), "typeText");
			},
			onDeath(handler) {
				deathHandlers.push(handler);
			},
			async close() {
				if (closing) return;
				closing = true;
				if (alive && transport !== undefined) {
					alive = false;
					const bye = new Promise<void>((resolve) => {
						pending.set("shutdown", {
							op: "shutdown",
							resolve: () => resolve(),
							timer: setTimeout(resolve, SHUTDOWN_WAIT_MS),
						});
					});
					try {
						transport.send(encodeRequest({ id: "shutdown", op: "shutdown" }));
						await bye;
					} catch {
						// stdin already closed
					}
				}
				failAll(driverError("E_HELPER_CRASHED", "warden-uiad was closed"));
				await transport?.close().catch(() => undefined);
			},
		},
	};
}

/** True when the request never reached the server (it was already gone), so the call can be made again without doubling its effect. */
export function neverSent(error: DriverError): boolean {
	const detail: unknown = error.detail;
	return typeof detail === "object" && detail !== null && "sent" in detail && detail.sent === false;
}

/** True when `error` is the server saying another UiAutomation client holds the device. */
export function isBusy(error: DriverError): boolean {
	const detail: unknown = error.detail;
	return (
		error.code === "E_AX_UNAVAILABLE" &&
		typeof detail === "object" &&
		detail !== null &&
		"reason" in detail &&
		detail.reason === "uiautomation_busy"
	);
}
