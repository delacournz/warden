import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AsyncResult, ok, type Result } from "@delacour/warden-types/result";
import type { DriverError, DriverResult } from "../../driver.types";
import { driverError } from "../../errors";
import { openAuSocket } from "./au-socket";
import { emudSize } from "./emud";
import {
	parseWmSize,
	type RecorderProcess,
	type ScreenrecordSource,
	type Size,
	screenrecordArgv,
	screenrecordSize,
	startScreenrecordSource,
} from "./screenrecord";

/** The iOS helper's reply `framing` string, verbatim: both platforms write the same units. */
export const STREAM_FRAMING = "u32 length, u8 flags (1 key, 2 config), u64 pts_us, Annex-B; big-endian";

export type StreamSourceChoice = "auto" | "grpc" | "screenrecord";

/**
 * `stream.start{fps?, bitrate?, maxEdge?, keepaliveMs?, path?, source?}`, the iOS helper's ranges and defaults:
 * `fps` 1–60 (60), `bitrate` 100 000–20 000 000 (4 000 000), `maxEdge` 160–8192 or 0 = device pixels (1280),
 * `keepaliveMs` 100–10 000 (1000), `path` the socket (default under the temp dir). Android adds `source`:
 * `auto` (the emulator's gRPC frames when it has them, else `screenrecord`), `grpc` or `screenrecord`.
 */
export type StreamParams = {
	fps: number;
	bitrate: number;
	maxEdge: number;
	keepaliveMs: number;
	path?: string;
	source: StreamSourceChoice;
};

function badRequest(message: string): DriverError {
	return driverError("E_BAD_REQUEST", message);
}

function fail(error: DriverError): { success: false; error: DriverError } {
	return { success: false, error };
}

export function parseStreamParams(raw: Record<string, unknown>): Result<StreamParams, DriverError> {
	const int = (
		key: string,
		fallback: number,
		min: number,
		max: number,
		extra?: number
	): Result<number, DriverError> => {
		const value = raw[key];
		if (value === undefined || value === null) return ok(fallback);
		if (typeof value !== "number" || !Number.isInteger(value) || ((value < min || value > max) && value !== extra)) {
			return fail(
				badRequest(`"${key}" must be an integer in ${min}...${max}${extra !== undefined ? ` (or ${extra})` : ""}`)
			);
		}
		return ok(value);
	};
	const fps = int("fps", 60, 1, 60);
	if (!fps.success) return fps;
	const bitrate = int("bitrate", 4_000_000, 100_000, 20_000_000);
	if (!bitrate.success) return bitrate;
	const maxEdge = int("maxEdge", 1280, 160, 8192, 0);
	if (!maxEdge.success) return maxEdge;
	const keepaliveMs = int("keepaliveMs", 1000, 100, 10_000);
	if (!keepaliveMs.success) return keepaliveMs;
	const path = raw.path;
	if (path !== undefined && path !== null && (typeof path !== "string" || path.length === 0)) {
		return fail(badRequest('"path" must be a non-empty string'));
	}
	const source = raw.source ?? "auto";
	if (source !== "auto" && source !== "grpc" && source !== "screenrecord") {
		return fail(badRequest('"source" must be "auto", "grpc" or "screenrecord"'));
	}
	return ok({
		fps: fps.data,
		bitrate: bitrate.data,
		maxEdge: maxEdge.data,
		keepaliveMs: keepaliveMs.data,
		...(typeof path === "string" ? { path } : {}),
		source,
	});
}

export type ExecResult = { exitCode: number; stdout: string; stderr: string };

/** Where the emulator's gRPC bridge listens (`@delacour/warden-core/providers/android-grpc` reads it). */
export type StreamGrpcEndpoint = { host: string; port: number; token: string };

/** A running gRPC-fed encoder (the native `warden-emud`), whatever starts it. */
export type GrpcStream = {
	readonly reply: Record<string, unknown>;
	keyframe(): DriverResult<unknown>;
	stats(): DriverResult<Record<string, unknown>>;
	stop(): Promise<void>;
};

export type AndroidStreamDeps = {
	serial: string;
	adb: string;
	exec: (cmd: readonly string[]) => Promise<ExecResult>;
	spawn: (argv: readonly string[]) => RecorderProcess;
	/** the emulator's gRPC endpoint; undefined for a phone or an emulator without the bridge */
	grpcEndpoint: () => StreamGrpcEndpoint | undefined;
	/** start the gRPC-fed encoder at `size` (the display capped at `maxEdge`); absent = only `screenrecord` */
	startGrpc?: (
		endpoint: StreamGrpcEndpoint,
		params: StreamParams,
		path: string,
		size: Size
	) => AsyncResult<GrpcStream, DriverError>;
	defaultSocketPath?: string;
	log?: (line: string) => void;
};

type Running =
	| {
			kind: "screenrecord";
			reply: Record<string, unknown>;
			stop(): void;
			keyframe(): void;
			stats(): Record<string, unknown>;
	  }
	| { kind: "grpc"; stream: GrpcStream };

/**
 * `stream.*` for one Android device, the same ops and replies as the iOS helper, so the stream publisher drives both
 * alike. The emulator's gRPC frames (hardware VideoToolbox encode on the Mac) when the device has the bridge and
 * `startGrpc` is wired, else `screenrecord` at half size (the guest's own encoder), re-framed onto the same socket.
 * A new `start` replaces a running stream.
 */
export function androidStreamService(deps: AndroidStreamDeps) {
	let running: Running | undefined;

	const stopRunning = async (): Promise<boolean> => {
		const current = running;
		running = undefined;
		if (current === undefined) return false;
		if (current.kind === "grpc") await current.stream.stop();
		else current.stop();
		return true;
	};

	const displaySize = async (): DriverResult<Size> => {
		const wm = await deps.exec([deps.adb, "-s", deps.serial, "shell", "wm", "size"]).catch((error: unknown) => ({
			exitCode: 1,
			stdout: "",
			stderr: String(error),
		}));
		const display = wm.exitCode === 0 ? parseWmSize(wm.stdout) : undefined;
		if (display === undefined) {
			return fail(
				driverError(
					"E_IO",
					`${deps.serial}: cannot read the display size (wm size: ${wm.stderr.trim() || wm.stdout.trim()})`
				)
			);
		}
		return ok(display);
	};

	const startScreenrecord = async (params: StreamParams, path: string, display: Size): DriverResult<Running> => {
		const size = screenrecordSize(display, params.maxEdge);
		let source: ScreenrecordSource | undefined;
		const socket = await openAuSocket({ path, onNeedKeyframe: () => source?.requestKeyframe() });
		source = startScreenrecordSource({
			argv: screenrecordArgv(deps.adb, deps.serial, size, params.bitrate, 180),
			spawn: deps.spawn,
			onUnit: (unit) => socket.send(unit),
			...(deps.log !== undefined ? { log: deps.log } : {}),
		});
		const recorder = source;
		const reply = {
			path,
			width: size.width,
			height: size.height,
			fps: params.fps,
			bitrate: params.bitrate,
			source: "screenrecord",
			framing: STREAM_FRAMING,
		};
		return ok({
			kind: "screenrecord",
			reply,
			keyframe: () => recorder.requestKeyframe(),
			stop: () => {
				recorder.stop();
				socket.close();
			},
			stats: () => ({ ...reply, ...recorder.stats(), ...socket.stats() }),
		});
	};

	return {
		async start(raw: Record<string, unknown>): DriverResult<unknown> {
			const params = parseStreamParams(raw);
			if (!params.success) return params;
			await stopRunning();
			const path =
				params.data.path ??
				deps.defaultSocketPath ??
				join(tmpdir(), `wand-${deps.serial.replace(/[^\w.-]/g, "_")}.sock`);
			const endpoint = params.data.source === "screenrecord" ? undefined : deps.grpcEndpoint();
			if (params.data.source === "grpc" && (endpoint === undefined || deps.startGrpc === undefined)) {
				return fail(driverError("E_UNSUPPORTED", `${deps.serial} has no emulator gRPC bridge to stream from`));
			}
			const display = await displaySize();
			if (!display.success) return display;
			if (endpoint !== undefined && deps.startGrpc !== undefined) {
				const grpc = await deps.startGrpc(endpoint, params.data, path, emudSize(display.data, params.data.maxEdge));
				if (grpc.success) {
					running = { kind: "grpc", stream: grpc.data };
					return ok(grpc.data.reply);
				}
				if (params.data.source === "grpc") return grpc;
				deps.log?.(`${deps.serial}: gRPC stream failed (${grpc.error.message}), using screenrecord`);
			}
			const started = await startScreenrecord(params.data, path, display.data);
			if (!started.success) return started;
			running = started.data;
			return started.data.kind === "screenrecord" ? ok(started.data.reply) : ok(started.data.stream.reply);
		},
		async keyframe(): DriverResult<unknown> {
			if (running === undefined) return fail(badRequest("no stream is running"));
			if (running.kind === "grpc") return running.stream.keyframe();
			running.keyframe();
			return ok({});
		},
		async stats(): DriverResult<unknown> {
			if (running === undefined) return fail(badRequest("no stream is running"));
			return running.kind === "grpc" ? running.stream.stats() : ok(running.stats());
		},
		async stop(): DriverResult<unknown> {
			return ok({ stopped: await stopRunning() });
		},
	};
}
