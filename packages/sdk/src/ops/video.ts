import { closeSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { androidTools } from "@delacour/warden-providers/android-tools";
import { type PidAlive, processAlive } from "@delacour/warden-store/liveness";
import {
	mayBeRecorded,
	type ProcessCommand,
	processCommand,
	recordedIdentity,
	safeToSignal,
} from "@delacour/warden-store/process-identity";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { fail, opError } from "./errors";
import { uiDir } from "./paths";
import type { OpDone, OpOutcome, OpSession } from "./session";
import type { DeviceState } from "./state-store";

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

type VideoRecord = NonNullable<DeviceState["video"]>;

/** What the recorder's command line carries (its argv names the device and the output file): tells it from a reused pid. */
const recorderMarks = (udid: string, video: VideoRecord): string[] => [udid, video.remote ?? video.path];

function nextVideoPath(home: string, udid: string): string {
	const dir = join(uiDir(home, udid), "videos");
	mkdirSync(dir, { recursive: true });
	let highest = 0;
	for (const file of readdirSync(dir)) {
		const n = /^(\d{3,})\.mp4$/.exec(file)?.[1];
		if (n !== undefined) highest = Math.max(highest, Number(n));
	}
	return join(dir, `${String(highest + 1).padStart(3, "0")}.mp4`);
}

/** `start [path]` | `stop`; any other action is a usage error. */
export type VideoParams = { action: string; path?: string };

export type VideoResult =
	| { action: "video"; state: "recording"; path: string; pid: number }
	| { action: "video"; state: "stopped"; path: string };

/** What `video start` and `video stop` share: the session, the recorder's effects, its adb and the saved record. */
type VideoRun = { session: OpSession; deps: VideoDeps; adb: string; state: DeviceState };

/** The recorder's command: `simctl recordVideo` on iOS, `screenrecord` to a device file on Android. */
function recorderArgv(run: VideoRun, path: string, remote: string | undefined): string[] {
	const { adb, session } = run;
	const id = session.device.id;
	return remote === undefined
		? ["xcrun", "simctl", "io", id, "recordVideo", "--codec=h264", "--force", path]
		: [adb, "-s", id, "shell", "screenrecord", remote];
}

/** `video start [path]`: spawn the detached recorder and remember it in the session's state. */
function startVideo(run: VideoRun, pathArg: string | undefined): Result<OpDone<VideoResult>, WardenError> {
	const { session, deps, state } = run;
	const { host, device } = session;
	if (state.video && mayBeRecorded(deps, state.video.pid, recorderMarks(device.id, state.video))) {
		return fail(
			opError("usage", `already recording to ${state.video.path}`, {
				hint: "`warden ui screen video stop` first",
			})
		);
	}
	const path = pathArg === undefined ? nextVideoPath(host.home, device.id) : resolve(host.cwd, pathArg);
	mkdirSync(dirname(path), { recursive: true });
	mkdirSync(uiDir(host.home, device.id), { recursive: true });
	const remote = device.platform === "android" ? `/sdcard/warden-ui-${host.now()}.mp4` : undefined;
	const argv = recorderArgv(run, path, remote);
	const { pid } = deps.spawnDetached({ argv, logPath: join(uiDir(host.home, device.id), "video.log") });
	session.state.update((current) => ({
		...current,
		video: { pid, path, ...(remote !== undefined ? { remote } : {}), startedAt: host.now() },
	}));
	return resultFactory.ok({
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
	const { session, deps } = run;
	const { host, device } = session;
	const warnings: string[] = [];
	await host.exec([run.adb, "-s", device.id, "shell", "pkill", "-2", "screenrecord"]);
	if (ours) deps.kill(running.pid, "SIGINT");
	await host.sleep(SCREENRECORD_FINISH_MS);
	const pulled = await host.exec([run.adb, "-s", device.id, "pull", remote, running.path]);
	if (pulled.exitCode !== 0) {
		warnings.push(`could not pull ${remote}: ${pulled.stderr.trim() || `exit ${pulled.exitCode}`}`);
	}
	await host.exec([run.adb, "-s", device.id, "shell", "rm", remote]);
	return warnings;
}

/** iOS: SIGINT the recorder so the mp4 is finalised, wait for it to end, SIGKILL it if it ignores that. */
async function stopHostRecorder(
	run: VideoRun,
	running: VideoRecord,
	ours: boolean,
	marks: string[]
): Promise<string[]> {
	const { session, deps } = run;
	if (!ours) return [`the recorder (pid ${running.pid}) had already ended: ${running.path} may be unfinished`];
	deps.kill(running.pid, "SIGINT");
	let waited = 0;
	while (deps.pidAlive(running.pid) && waited < VIDEO_STOP_WAIT_MS) {
		await session.host.sleep(POLL_MS);
		waited += POLL_MS;
	}
	if (!safeToSignal(deps, running.pid, marks)) return [];
	deps.kill(running.pid, "SIGKILL");
	return ["the recorder ignored SIGINT and was killed: the file may be unfinished"];
}

/** `video stop`: finish the recorder (pulling the file on Android) and forget it. */
async function stopVideo(run: VideoRun): Promise<Result<OpDone<VideoResult>, WardenError>> {
	const { session, deps, state } = run;
	const running = state.video;
	if (!running) {
		return fail(opError("usage", "not recording", { hint: "`warden ui screen video start` first" }));
	}
	const marks = recorderMarks(session.device.id, running);
	const identity = recordedIdentity(deps, running.pid, marks);
	if (running.remote === undefined && identity === "unknown") {
		// alive but its command line unreadable: it may still be the recorder, so it is neither signalled nor forgotten
		return resultFactory.ok({
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
	session.state.update((current) => {
		if (current.video?.pid !== running.pid) return current;
		const { video: _stopped, ...rest } = current;
		return rest;
	});
	return resultFactory.ok({
		result: { action: "video", state: "stopped", path: running.path },
		text: running.path,
		warnings,
	});
}

/**
 * `screen video start [path]` / `video stop`. The recorder is a detached host process whose pid is kept in the
 * session's {@link StateStore}: iOS `xcrun simctl io <udid> recordVideo`, Android `adb shell screenrecord` (3 minute
 * device limit; `stop` pulls the file). `stop` sends SIGINT so the mp4 is finalised. Default path
 * `<home>/ui/<udid>/videos/NNN.mp4`.
 */
export async function video(session: OpSession, params: VideoParams): OpOutcome<VideoResult> {
	const run: VideoRun = {
		session,
		deps: session.video ?? defaultVideoDeps,
		adb: androidTools(session.host.env).adb,
		state: session.state.read(),
	};
	if (params.action === "start") return startVideo(run, params.path);
	if (params.action === "stop") return stopVideo(run);
	return fail(opError("usage", `unknown video action "${params.action}"`, { hint: "start [path] or stop" }));
}
