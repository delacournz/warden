import type { Exec } from "@delacour/warden-runtime/exec";
import type { SimWindowArranger } from "./sim-windows";

/** Loads the one class a close needs; tests count loads. */
export type SimWindowsLoader = () => Promise<{ SimWindowArranger: typeof SimWindowArranger }>;

/** An iOS sim warden just shut down. */
export type ShutDownSim = { udid: string; name: string };

export type SimWindowCloserDeps = { exec: Exec; os?: NodeJS.Platform };

export class SimWindowCloser {
	constructor(
		private readonly deps: SimWindowCloserDeps,
		private readonly load: SimWindowsLoader = () => import("./sim-windows")
	) {}

	/**
	 * After warden shut iOS sims down (any path: `warden dev`, `release --shutdown`, SessionEnd, batch, gc, the capacity
	 * gate): close their viewer windows, so a Device Hub page offering "Start" (Xcode 27) or a dark Simulator.app window
	 * is not left behind. One osascript call for all of them. Returns the problem, if any — a window left open never
	 * fails a shutdown. `./sim-windows` is imported only when there is something to close on macOS.
	 */
	async after(sims: readonly ShutDownSim[]): Promise<string | undefined> {
		const os = this.deps.os ?? process.platform;
		if (os !== "darwin" || sims.length === 0) return undefined;
		const { SimWindowArranger } = await this.load();
		const closed = await new SimWindowArranger({ exec: this.deps.exec, os }).close(sims);
		return closed.success ? undefined : closed.error;
	}
}
