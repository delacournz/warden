import { closeSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type PidAlive, processAlive } from "@delacour/warden-core/liveness";
import { androidTools } from "@delacour/warden-core/providers/android";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { UiDevice } from "./device";
import type { UiDeps } from "./driver";
import { type UiError, type UiSuccess, uiError } from "./output";
import { uiDir } from "./paths";
import { mayBeRecorded, type ProcessCommand, processCommand, recordedIdentity, safeToSignal } from "./process-identity";
import { runUi, type UiOptionValues } from "./run";
import { readState, type UiState, updateState } from "./state";

/** `video stop` waits this long for the recorder to finish the file before it SIGKILLs it. */
export const VIDEO_STOP_WAIT_MS = 5000;
/** Android: how long `screenrecord` gets to write the mp4 trailer after SIGINT. */
export const SCREENRECORD_FINISH_MS = 1500;
const POLL_MS = 100;

export type VideoSpec = { argv: string[]; logPath: string };

/** Everything impure about `video start|stop`; tests replace it. */
export type VideoDeps = {
	/** start the recorder detached from this process (survives our exit) */
	spawnDetached: (spec: VideoSpec) => { pid: number };
	kill: (pid: number, signal: "SIGINT" | "SIGKILL") => void;
	pidAlive: PidAlive;
	/** a pid's command line (`ps`): the recorded pid is signalled only while it still names this device and file. Absent: liveness alone */
	command?: ProcessCommand;
};

export const defaultVideoDeps: VideoDeps = {
	spawnDetached: ({ argv, logPath }) => {
		const log = openSync(logPath, "a");
		try {
			const proc = Bun.spawn(argv, { stdin: "ignore", stdout: log, stderr: log, detached: true });
			proc.unref();
			return { pid: proc.pid };
		} finally {
			closeSync(log);
		}
	},
	kill: (pid, signal) => {
		try {
			process.kill(pid, signal);
		} catch {
			// already gone
		}
	},
	pidAlive: processAlive,
	command: processCommand,
};

type VideoRecord = NonNullable<UiState["video"]>;

/** What the recorder's command line carries (its argv names the device and the output file): tells it from a reused pid. */
const recorderMarks = (udid: string, video: VideoRecord): string[] => [udid, video.remote ?? video.path];

function nextVideoPath(ctx: CommandContext, udid: string): string {
	const dir = join(uiDir(ctx, udid), "videos");
	mkdirSync(dir, { recursive: true });
	let highest = 0;
	for (const file of readdirSync(dir)) {
		const n = /^(\d{3,})\.mp4$/.exec(file)?.[1];
		if (n !== undefined) highest = Math.max(highest, Number(n));
	}
	return join(dir, `${String(highest + 1).padStart(3, "0")}.mp4`);
}

/**
 * `warden ui screen video start [path]` / `video stop`. The recorder is a detached host process whose pid is kept in
 * `state.json`: iOS `xcrun simctl io <udid> recordVideo`, Android `adb shell screenrecord` (3 minute device
 * limit; `stop` pulls the file). `stop` sends SIGINT so the mp4 is finalised. Default path
 * `$WARDEN_HOME/ui/<udid>/videos/NNN.mp4`.
 */
export function uiVideo(
	ctx: CommandContext,
	deps: UiDeps,
	what: string,
	pathArg: string | undefined,
	opts: UiOptionValues
): Promise<number> {
	return runUi(ctx, deps, "screen video", opts, async (device) => {
		const run: VideoRun = {
			ctx,
			deps,
			video: deps.video ?? defaultVideoDeps,
			device,
			adb: androidTools(ctx.env).adb,
			state: readState(ctx, device.udid),
		};
		if (what === "start") return startVideo(run, pathArg);
		if (what === "stop") return stopVideo(run);
		return {
			success: false,
			error: uiError("usage", `unknown video action "${what}"`, { hint: "start [path] or stop" }),
		};
	});
}

/** What `video start` and `video stop` share: the context, the recorder's effects, the device, its adb and its saved state. */
type VideoRun = {
	ctx: CommandContext;
	deps: UiDeps;
	video: VideoDeps;
	device: UiDevice;
	adb: string;
	state: UiState;
};

const deviceInfo = (device: UiDevice) => ({ udid: device.udid, platform: device.platform, name: device.name });

/** The recorder's command: `simctl recordVideo` on iOS, `screenrecord` to a device file on Android. */
function recorderArgv(run: VideoRun, path: string, remote: string | undefined): string[] {
	const { adb, device } = run;
	return remote === undefined
		? ["xcrun", "simctl", "io", device.udid, "recordVideo", "--codec=h264", "--force", path]
		: [adb, "-s", device.udid, "shell", "screenrecord", remote];
}

/** `video start [path]`: spawn the detached recorder and remember it in `state.json`. */
function startVideo(run: VideoRun, pathArg: string | undefined): Result<UiSuccess, UiError> {
	const { ctx, video, device, state } = run;
	if (state.video && mayBeRecorded(video, state.video.pid, recorderMarks(device.udid, state.video))) {
		return {
			success: false,
			error: uiError("usage", `already recording to ${state.video.path}`, {
				hint: "`warden ui screen video stop` first",
			}),
		};
	}
	const path = pathArg === undefined ? nextVideoPath(ctx, device.udid) : resolve(ctx.cwd, pathArg);
	mkdirSync(dirname(path), { recursive: true });
	mkdirSync(uiDir(ctx, device.udid), { recursive: true });
	const remote = device.platform === "android" ? `/sdcard/warden-ui-${ctx.now()}.mp4` : undefined;
	const argv = recorderArgv(run, path, remote);
	const { pid } = video.spawnDetached({ argv, logPath: join(uiDir(ctx, device.udid), "video.log") });
	updateState(ctx, device.udid, (current) => ({
		...current,
		video: { pid, path, ...(remote !== undefined ? { remote } : {}), startedAt: ctx.now() },
	}));
	return ok({
		device: deviceInfo(device),
		result: { action: "video", state: "recording", path, pid },
		text: `recording to ${path}`,
		warnings: remote ? ["android screenrecord stops by itself after 3 minutes"] : [],
	});
}

/** Android: SIGINT `screenrecord`, give it time to write the mp4 trailer, pull the file and remove it from the device. */
async function stopRemoteRecorder(
	run: VideoRun,
	running: VideoRecord,
	remote: string,
	ours: boolean
): Promise<string[]> {
	const { ctx, deps, video, device, adb } = run;
	const warnings: string[] = [];
	await ctx.exec([adb, "-s", device.udid, "shell", "pkill", "-2", "screenrecord"]);
	if (ours) video.kill(running.pid, "SIGINT");
	await deps.sleep(SCREENRECORD_FINISH_MS);
	const pulled = await ctx.exec([adb, "-s", device.udid, "pull", remote, running.path]);
	if (pulled.exitCode !== 0) {
		warnings.push(`could not pull ${remote}: ${pulled.stderr.trim() || `exit ${pulled.exitCode}`}`);
	}
	await ctx.exec([adb, "-s", device.udid, "shell", "rm", remote]);
	return warnings;
}

/** iOS: SIGINT the recorder so the mp4 is finalised, wait for it to end, SIGKILL it if it ignores that. */
async function stopHostRecorder(
	run: VideoRun,
	running: VideoRecord,
	ours: boolean,
	marks: string[]
): Promise<string[]> {
	const { deps, video } = run;
	if (!ours) return [`the recorder (pid ${running.pid}) had already ended: ${running.path} may be unfinished`];
	video.kill(running.pid, "SIGINT");
	let waited = 0;
	while (video.pidAlive(running.pid) && waited < VIDEO_STOP_WAIT_MS) {
		await deps.sleep(POLL_MS);
		waited += POLL_MS;
	}
	if (!safeToSignal(video, running.pid, marks)) return [];
	video.kill(running.pid, "SIGKILL");
	return ["the recorder ignored SIGINT and was killed: the file may be unfinished"];
}

/** `video stop`: finish the recorder (pulling the file on Android) and forget it. */
async function stopVideo(run: VideoRun): Promise<Result<UiSuccess, UiError>> {
	const { ctx, video, device, state } = run;
	const running = state.video;
	if (!running) {
		return {
			success: false,
			error: uiError("usage", "not recording", { hint: "`warden ui screen video start` first" }),
		};
	}
	const marks = recorderMarks(device.udid, running);
	const identity = recordedIdentity(video, running.pid, marks);
	if (running.remote === undefined && identity === "unknown") {
		// alive but its command line unreadable: it may still be the recorder, so it is neither signalled nor forgotten
		return ok({
			device: deviceInfo(device),
			result: { action: "video", state: "recording", path: running.path, pid: running.pid },
			text: `recorder (pid ${running.pid}) left running`,
			warnings: [`could not stop the recorder (pid ${running.pid}): its command line could not be read`],
		});
	}
	const ours = identity === "match";
	const warnings =
		running.remote !== undefined
			? await stopRemoteRecorder(run, running, running.remote, ours)
			: await stopHostRecorder(run, running, ours, marks);
	updateState(ctx, device.udid, (current) => {
		if (current.video?.pid !== running.pid) return current;
		const { video: _stopped, ...rest } = current;
		return rest;
	});
	return ok({
		device: deviceInfo(device),
		result: { action: "video", state: "stopped", path: running.path },
		text: running.path,
		warnings,
	});
}
