import { SimWindowArranger } from "@delacour/warden-leasing/sim-windows";
import { type Core, guarded } from "./core";
import { WardenError } from "./errors";
import type { ArrangeParams, ArrangeResult, CallOptions, SimViewerKind } from "./sdk.types";

const isMac = (): boolean => process.platform === "darwin";

/** `devices.viewer`: which app shows simulator windows right now (`"none"` off macOS or when neither runs). */
export function viewerOf(core: Core, opts: CallOptions | undefined): Promise<SimViewerKind> {
	return guarded(core.signalFor(opts), async () =>
		isMac() ? (await new SimWindowArranger({ exec: core.host.exec }).detectViewer()).kind : "none"
	);
}

/**
 * `devices.arrange`: the engine behind `warden arrange`. With `open`, Device Hub is first asked for those sims'
 * windows (Xcode 27, only while it runs) and everything is tiled; otherwise the open windows of warden sims are
 * tiled in name order. Never launches a viewer. Off macOS nothing is done.
 */
export function arrangeWindows(
	core: Core,
	params: ArrangeParams | undefined,
	opts: CallOptions | undefined
): Promise<ArrangeResult> {
	return guarded(core.signalFor(opts), async (): Promise<ArrangeResult> => {
		if (!isMac()) return { arranged: [], opened: [], viewer: "none" };
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
