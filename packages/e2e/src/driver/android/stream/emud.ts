import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { ok } from "@delacour/warden-types/result";
import type { DriverError, DriverErrorCode, DriverResult } from "../../driver.types";
import { driverError } from "../../errors";
import { locateHelper } from "../../ios/locate-helper";
import type { GrpcStream, StreamGrpcEndpoint, StreamParams } from "./android-stream";
import type { Size } from "./screenrecord";

/** The env var `warden-emud` reads the emulator's gRPC token from (never argv, never a request). */
export const EMUD_TOKEN_ENV = "WARDEN_EMU_GRPC_TOKEN";
export const EMUD_BINARY = "warden-emud";

/** A running `warden-emud` (`Bun.spawn` with `stdin: "pipe"` fits). */
export type EmudProcess = {
	stdin: { write(chunk: string): unknown; end(): unknown };
	stdout: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(): void;
};

/** `warden-emud` ships beside `warden-simd` (`native/dist`, the platform package's `bin/`, `$WARDEN_HOME/simd/<v>/`). */
export function emudBeside(helperPath: string, exists: (path: string) => boolean): string | undefined {
	const candidate = join(dirname(helperPath), EMUD_BINARY);
	return exists(candidate) ? candidate : undefined;
}

/** Find `warden-emud` the way the iOS helper is found (`WARDEN_SIMD`, `WARDEN_HELPER_DIR`, beside `warden`, the source build, `$WARDEN_HOME/simd/<version>`), then beside it. */
export function locateEmud(input: {
	env: Readonly<Record<string, string | undefined>>;
	wardenHome: string;
	version?: string;
}): string | undefined {
	const helper = locateHelper({
		env: input.env,
		execPath: process.execPath,
		importDir: join(import.meta.dir, "../../ios"),
		wardenHome: input.wardenHome,
		exists: existsSync,
		realpath: realpathSync,
		...(input.version !== undefined ? { version: input.version } : {}),
	});
	return helper.success ? emudBeside(helper.data.path, existsSync) : undefined;
}

/** The size the emulator is asked to send: its display, long side capped at `maxEdge` (0 = device pixels), even. */
export function emudSize(display: Size, maxEdge: number): Size {
	const long = Math.max(display.width, display.height);
	const scale = maxEdge > 0 && long > maxEdge ? maxEdge / long : 1;
	const even = (value: number) => Math.max(16, Math.round(value * scale) & ~1);
	return { width: even(display.width), height: even(display.height) };
}

export type StartEmudOptions = {
	binary: string;
	endpoint: StreamGrpcEndpoint;
	params: StreamParams;
	path: string;
	size: Size;
	spawn: (argv: readonly string[], env: Record<string, string>) => EmudProcess;
	readyTimeoutMs?: number;
	/** `stream.start` waits for the emulator's first frame (the helper's own limit is 5 s) */
	startTimeoutMs?: number;
	requestTimeoutMs?: number;
};

type Pending = { resolve: (reply: Reply) => void };
type Reply = { ok: true; data: unknown } | { ok: false; error: DriverError };

const WIRE_CODES: readonly DriverErrorCode[] = ["E_BAD_REQUEST", "E_TIMEOUT", "E_IO", "E_UNSUPPORTED", "E_INTERNAL"];

function wireError(raw: unknown): DriverError {
	const error = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const code = WIRE_CODES.find((known) => known === error.code) ?? "E_INTERNAL";
	return driverError(code, typeof error.message === "string" ? error.message : "warden-emud failed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Start `warden-emud` on the emulator's gRPC endpoint: the process reads frames over gRPC, encodes them with
 * VideoToolbox and serves them on `path` in the same framing as the iOS helper. One process per stream; `stop`
 * asks it to stop, closes its stdin and kills it if it lingers.
 */
export async function startEmudStream(options: StartEmudOptions): DriverResult<GrpcStream> {
	const child = options.spawn([options.binary], { [EMUD_TOKEN_ENV]: options.endpoint.token });
	const pending = new Map<string, Pending>();
	let nextId = 0;
	let exited = false;
	let onReady: (ready: boolean) => void = () => undefined;
	const ready = new Promise<boolean>((resolve) => {
		onReady = resolve;
	});

	const crashed = (why: string): Reply => ({ ok: false, error: driverError("E_HELPER_CRASHED", `warden-emud ${why}`) });

	void (async () => {
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					if (line.length === 0) continue;
					let message: unknown;
					try {
						message = JSON.parse(line);
					} catch {
						continue;
					}
					if (!isRecord(message)) continue;
					if (message.event === "ready") {
						onReady(true);
						continue;
					}
					const id = typeof message.id === "string" ? message.id : undefined;
					const waiter = id === undefined ? undefined : pending.get(id);
					if (id === undefined || waiter === undefined) continue;
					pending.delete(id);
					waiter.resolve(
						message.ok === true ? { ok: true, data: message.data } : { ok: false, error: wireError(message.error) }
					);
				}
			}
		} catch {}
	})();
	void child.exited.then((code) => {
		exited = true;
		onReady(false);
		for (const waiter of pending.values()) waiter.resolve(crashed(`exited ${code}`));
		pending.clear();
	});

	const request = (op: string, params: Record<string, unknown>, timeoutMs: number): Promise<Reply> => {
		if (exited) return Promise.resolve(crashed("is not running"));
		const id = String(++nextId);
		return new Promise<Reply>((resolve) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				resolve({ ok: false, error: driverError("E_TIMEOUT", `warden-emud ${op}: no reply in ${timeoutMs} ms`) });
			}, timeoutMs);
			pending.set(id, {
				resolve: (reply) => {
					clearTimeout(timer);
					resolve(reply);
				},
			});
			child.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
		});
	};

	const end = async (): Promise<void> => {
		try {
			child.stdin.end();
		} catch {}
		const timer = setTimeout(() => child.kill(), 1_000);
		await child.exited;
		clearTimeout(timer);
	};

	const readyTimeoutMs = options.readyTimeoutMs ?? 5_000;
	const timedOut = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), readyTimeoutMs));
	if (!(await Promise.race([ready, timedOut]))) {
		child.kill();
		return {
			success: false,
			error: driverError("E_HELPER_CRASHED", `warden-emud did not start in ${readyTimeoutMs} ms`),
		};
	}

	const { params, size, endpoint } = options;
	const started = await request(
		"stream.start",
		{
			host: endpoint.host,
			port: endpoint.port,
			width: size.width,
			height: size.height,
			fps: params.fps,
			bitrate: params.bitrate,
			keepaliveMs: params.keepaliveMs,
			path: options.path,
		},
		options.startTimeoutMs ?? 10_000
	);
	if (!started.ok) {
		await end();
		return { success: false, error: started.error };
	}
	const reply = isRecord(started.data) ? started.data : {};
	const timeoutMs = options.requestTimeoutMs ?? 5_000;
	const asResult = <T>(
		answer: Reply,
		map: (data: unknown) => T
	): { success: true; data: T } | { success: false; error: DriverError } =>
		answer.ok ? ok(map(answer.data)) : { success: false, error: answer.error };

	return ok({
		reply,
		keyframe: async () => asResult(await request("stream.keyframe", {}, timeoutMs), (data) => data),
		stats: async () => asResult(await request("stream.stats", {}, timeoutMs), (data) => (isRecord(data) ? data : {})),
		stop: async () => {
			await request("stream.stop", {}, timeoutMs);
			await end();
		},
	});
}
