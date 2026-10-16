import type { CommandContext } from "../context";

/**
 * `stopHelperAfter` (`agent-ui/close.ts`), imported on first use. close.ts pulls in the iOS driver, zod and the whole
 * `warden ui` runner (~150 modules, ~30 ms, ~65 MB); `hook`, `release` and `gc` run on every agent session end and most
 * of those release no device, so they only pay for it when a lease is actually released.
 */
export function stopHelperAfterOnDemand(ctx: Pick<CommandContext, "env" | "now">): (udid: string) => Promise<void> {
	return async (udid) => {
		const { stopHelperAfter } = await import("./close");
		await stopHelperAfter(ctx)(udid);
	};
}
