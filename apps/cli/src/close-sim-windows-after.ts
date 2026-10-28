import type { Exec } from "@delacour/warden-core/exec";
import type { closeSimWindows } from "./sim-windows";

/** Loads the one function a close needs; tests count loads. */
export type SimWindowsLoader = () => Promise<{ closeSimWindows: typeof closeSimWindows }>;

const loadSimWindows: SimWindowsLoader = () => import("./sim-windows");

/** An iOS sim warden just shut down. */
export type ShutDownSim = { udid: string; name: string };

/**
 * After warden shut iOS sims down (any path: `warden dev`, `release --shutdown`, SessionEnd, batch, gc, the capacity
 * gate): close their viewer windows, so a Device Hub page offering "Start" (Xcode 27) or a dark Simulator.app window
 * is not left behind. One osascript call for all of them. Returns the problem, if any — a window left open never
 * fails a shutdown. `./sim-windows` is imported only when there is something to close on macOS.
 */
export async function closeSimWindowsAfter(
	deps: { exec: Exec; os?: NodeJS.Platform },
	sims: readonly ShutDownSim[],
	load: SimWindowsLoader = loadSimWindows
): Promise<string | undefined> {
	const os = deps.os ?? process.platform;
	if (os !== "darwin" || sims.length === 0) return undefined;
	const { closeSimWindows } = await load();
	const closed = await closeSimWindows({ exec: deps.exec, os }, sims);
	return closed.success ? undefined : closed.error;
}
