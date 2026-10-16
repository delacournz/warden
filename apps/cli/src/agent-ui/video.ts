import { closeSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type PidAlive, processAlive } from "@delacour/warden-core/liveness";
import { androidTools } from "@delacour/warden-core/providers/android";
import { ok } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { UiDeps } from "./driver";
import { uiError } from "./output";
import { uiDir } from "./paths";
import { runUi, type UiOptionValues } from "./run";
import { readState, writeState } from "./state";

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
};

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
 * `warden ui video start [path]` / `video stop`. The recorder is a detached host process whose pid is kept in
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
	return runUi(ctx, deps, "video", opts, async (device) => {
		const video = deps.video ?? defaultVideoDeps;
		const info = { udid: device.udid, platform: device.platform, name: device.name };
		const state = readState(ctx, device.udid);
		const adb = androidTools(ctx.env).adb;

		if (what === "start") {
			if (state.video && video.pidAlive(state.video.pid)) {
				return {
					success: false,
					error: uiError("usage", `already recording to ${state.video.path}`, { hint: "`warden ui video stop` first" }),
				};
			}
			const path = pathArg === undefined ? nextVideoPath(ctx, device.udid) : resolve(ctx.cwd, pathArg);
			mkdirSync(dirname(path), { recursive: true });
			mkdirSync(uiDir(ctx, device.udid), { recursive: true });
			const remote = device.platform === "android" ? `/sdcard/warden-ui-${ctx.now()}.mp4` : undefined;
			const argv =
				remote === undefined
					? ["xcrun", "simctl", "io", device.udid, "recordVideo", "--codec=h264", "--force", path]
					: [adb, "-s", device.udid, "shell", "screenrecord", remote];
			const { pid } = video.spawnDetached({ argv, logPath: join(uiDir(ctx, device.udid), "video.log") });
			writeState(ctx, device.udid, {
				...state,
				video: { pid, path, ...(remote !== undefined ? { remote } : {}), startedAt: ctx.now() },
			});
			return ok({
				device: info,
				result: { action: "video", state: "recording", path, pid },
				text: `recording to ${path}`,
				warnings: remote ? ["android screenrecord stops by itself after 3 minutes"] : [],
			});
		}

		if (what === "stop") {
			const running = state.video;
			if (!running) {
				return { success: false, error: uiError("usage", "not recording", { hint: "`warden ui video start` first" }) };
			}
			const warnings: string[] = [];
			if (running.remote !== undefined) {
				await ctx.exec([adb, "-s", device.udid, "shell", "pkill", "-2", "screenrecord"]);
				video.kill(running.pid, "SIGINT");
				await deps.sleep(SCREENRECORD_FINISH_MS);
				const pulled = await ctx.exec([adb, "-s", device.udid, "pull", running.remote, running.path]);
				if (pulled.exitCode !== 0) {
					warnings.push(`could not pull ${running.remote}: ${pulled.stderr.trim() || `exit ${pulled.exitCode}`}`);
				}
				await ctx.exec([adb, "-s", device.udid, "shell", "rm", running.remote]);
			} else {
				video.kill(running.pid, "SIGINT");
				let waited = 0;
				while (video.pidAlive(running.pid) && waited < VIDEO_STOP_WAIT_MS) {
					await deps.sleep(POLL_MS);
					waited += POLL_MS;
				}
				if (video.pidAlive(running.pid)) {
					video.kill(running.pid, "SIGKILL");
					warnings.push("the recorder ignored SIGINT and was killed: the file may be unfinished");
				}
			}
			const { video: _stopped, ...rest } = state;
			writeState(ctx, device.udid, rest);
			return ok({
				device: info,
				result: { action: "video", state: "stopped", path: running.path },
				text: running.path,
				warnings,
			});
		}

		return {
			success: false,
			error: uiError("usage", `unknown video action "${what}"`, { hint: "start [path] or stop" }),
		};
	});
}
