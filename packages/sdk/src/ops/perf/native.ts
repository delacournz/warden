import type { PerfSession } from "@delacour/warden-perf/shared/session.schema";
import type { Platform } from "@delacour/warden-store/types";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { opErrors } from "../errors";
import type { PerfUiEnv } from "./env";
import {
	findRunningOneShot,
	type HandleFile,
	newOneShotDir,
	readHandleFile,
	sessionNativeDir,
	writeHandleFile,
} from "./native-state";
import type { NativeHandle, NativeIo, NativeProfiler, NativeStopped } from "./native-types";
import { activeSessionFor, updateSession } from "./session";
import type { PerfEngineDeps, PerfTarget } from "./types";

/** The profiler for a platform. iOS and Android load lazily so `perf --help` and every other subcommand skip them. */
export type NativeProfilers = Record<Platform, () => Promise<NativeProfiler>>;

export const defaultNativeProfilers: NativeProfilers = {
	ios: async () => (await import("@delacour/warden-sdk/ops/perf/native-ios")).iosNativeProfiler,
	android: async () => (await import("@delacour/warden-sdk/ops/perf/native-android")).androidNativeProfiler,
};

/** Where a recording lives: a running session's `native/`, or a one-shot dir. */
export type NativeRun = { dir: string; sessionId?: string; handle: NativeHandle; app: string; leaks: boolean };

export type StartNativeOptions = {
	app: string;
	leaks: boolean;
	flavor?: string;
	maxDurationMs: number;
};

/**
 * Begin a native recording on `target` and persist what `stop` needs (`native/handle.json`, plus a `native` capturer in
 * the device's running session). The capture API `perf start --native` (PRF-9) calls. `--leaks` is a MUTATE (cold launch):
 * the caller resolved `target` in `mutate` mode.
 */
export async function startNative(
	ctx: PerfUiEnv,
	deps: PerfEngineDeps,
	io: NativeIo,
	profilers: NativeProfilers,
	target: PerfTarget,
	opts: StartNativeOptions,
	session: PerfSession | undefined = activeSessionFor(ctx, deps.session, target.udid)
): Promise<Result<NativeRun, WardenError>> {
	if (session?.capturers.some((c) => c.kind === "native" && c.state === "running")) {
		return {
			success: false,
			error: opErrors.opError("session_active", `session ${session.id} already has a native recording`, {
				hint: "warden perf native stop",
			}),
		};
	}
	if (session === undefined && findRunningOneShot(ctx, target.udid) !== undefined) {
		return {
			success: false,
			error: opErrors.opError("session_active", `a native recording is already running on ${target.udid}`, {
				hint: "warden perf native stop",
			}),
		};
	}
	const dir = session === undefined ? newOneShotDir(ctx, deps.session.random) : sessionNativeDir(ctx, session.id);
	const profiler = await profilers[target.platform]();
	const started = await profiler.start(ctx, deps, io, {
		target,
		app: opts.app,
		dir,
		leaks: opts.leaks,
		...(opts.flavor === undefined ? {} : { flavor: opts.flavor }),
		maxDurationMs: opts.maxDurationMs,
	});
	if (!started.success) return started;
	const file: HandleFile = {
		version: 1,
		status: "running",
		udid: target.udid,
		platform: target.platform,
		app: opts.app,
		leaks: opts.leaks,
		...(session === undefined ? {} : { sessionId: session.id }),
		handle: started.data,
	};
	writeHandleFile(dir, file);
	if (session !== undefined) {
		updateSession(ctx, session.id, (s) => ({
			...s,
			capturers: [
				...s.capturers.filter((c) => c.kind !== "native"),
				{
					kind: "native",
					...(started.data.pid === undefined ? {} : { pid: started.data.pid }),
					startedAtIso: started.data.startedAtIso,
					out: started.data.out,
					state: "running",
				},
			],
		}));
	}
	return resultFactory.ok({
		dir,
		...(session === undefined ? {} : { sessionId: session.id }),
		handle: started.data,
		app: opts.app,
		leaks: opts.leaks,
	});
}

/** The recording running on `udid`: the session (`sessionId`, else the device's active one) first, else a one-shot. `perf stop` names the session because a capped one no longer counts as active. */
export function findNativeRun(
	ctx: PerfUiEnv,
	deps: PerfEngineDeps,
	udid: string,
	sessionId?: string
): { dir: string; file: HandleFile } | undefined {
	const sessionKey = sessionId ?? activeSessionFor(ctx, deps.session, udid)?.id;
	if (sessionKey !== undefined) {
		const dir = sessionNativeDir(ctx, sessionKey);
		const file = readHandleFile(dir);
		if (file?.status === "running") return { dir, file };
	}
	return findRunningOneShot(ctx, udid);
}

export type StoppedNative = NativeStopped & { dir: string; sessionId?: string; app: string };

/** Stop the recording `findNativeRun` finds, export + analyze it, and mark it stopped. */
export async function stopNative(
	ctx: PerfUiEnv,
	deps: PerfEngineDeps,
	io: NativeIo,
	profilers: NativeProfilers,
	target: PerfTarget,
	opts: { analyze: boolean; yes?: boolean; sessionId?: string }
): Promise<Result<StoppedNative, WardenError>> {
	const found = findNativeRun(ctx, deps, target.udid, opts.sessionId);
	if (found === undefined) {
		return {
			success: false,
			error: opErrors.opError("session_not_found", `no native recording is running on ${target.udid}`, {
				hint: "warden perf native start",
			}),
		};
	}
	const { dir, file } = found;
	const profiler = await profilers[file.platform]();
	const stopped = await profiler.stop(ctx, deps, io, {
		target,
		app: file.app,
		dir,
		handle: file.handle,
		analyze: opts.analyze,
		...(opts.yes === true ? { yes: true } : {}),
	});
	writeHandleFile(dir, { ...file, status: "stopped" });
	if (file.sessionId !== undefined) {
		updateSession(ctx, file.sessionId, (s) => ({
			...s,
			capturers: s.capturers.map((c) =>
				c.kind === "native" && c.state === "running" ? { ...c, state: stopped.success ? "stopped" : "failed" } : c
			),
		}));
	}
	if (!stopped.success) return stopped;
	return resultFactory.ok({
		...stopped.data,
		dir,
		...(file.sessionId === undefined ? {} : { sessionId: file.sessionId }),
		app: file.app,
	});
}
