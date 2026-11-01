import { SimWindowArranger } from "@delacour/warden-leasing/sim-windows";
import { type Core, coreRuntime } from "./core";
import { WardenError } from "./errors";
import type { ArrangeParams, ArrangeResult, CallOptions, SimViewerKind } from "./sdk.types";

/** `devices.viewer` and `devices.arrange`: simulator window management behind the client. */
export class DeviceWindows {
	constructor(private readonly core: Core) {}

	/** `devices.viewer`: which app shows simulator windows right now (`"none"` off macOS or when neither runs). */
	viewer(opts: CallOptions | undefined): Promise<SimViewerKind> {
		const { core } = this;
		return coreRuntime.guarded(core.signalFor(opts), async () =>
			this.isMac() ? (await new SimWindowArranger({ exec: core.host.exec }).detectViewer()).kind : "none"
		);
	}

	/**
	 * `devices.arrange`: the engine behind `warden arrange`. With `open`, Device Hub is first asked for those sims'
	 * windows (Xcode 27, only while it runs) and everything is tiled; otherwise the open windows of warden sims are
	 * tiled in name order. Never launches a viewer. Off macOS nothing is done.
	 */
	arrange(params: ArrangeParams | undefined, opts: CallOptions | undefined): Promise<ArrangeResult> {
		const { core } = this;
		return coreRuntime.guarded(core.signalFor(opts), async (): Promise<ArrangeResult> => {
			if (!this.isMac()) return { arranged: [], opened: [], viewer: "none" };
			const open = params?.open ?? [];
			if (open.length > 0) {
				const deps = { exec: core.host.exec, env: core.host.env };
				const opened = await new SimWindowArranger(deps).reopen(open);
				return {
					arranged: [],
					opened,
					viewer: (await new SimWindowArranger({ exec: core.host.exec }).detectViewer()).kind,
				};
			}
			const result = await new SimWindowArranger({ exec: core.host.exec }).arrange();
			if (!result.success) throw new WardenError({ code: "failed", message: result.error });
			return { arranged: result.data.arranged, opened: [], viewer: result.data.viewer };
		});
	}

	private isMac(): boolean {
		return process.platform === "darwin";
	}
}
