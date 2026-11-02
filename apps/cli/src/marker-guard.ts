import { markerBlock, realMarkerFs } from "@delacour/warden-core/ownership";
import type { CommandContext } from "./context";

/** Why this iOS sim is off limits to a destructive step (its ownership marker names another warden instance), else undefined. */
export const simMarkerBlock = (ctx: CommandContext, udid: string): string | undefined =>
	markerBlock(realMarkerFs, ctx.env, ctx.store(), udid);

/** `shouldShutdown`'s `ownedElsewhere`: only simulators carry a marker. */
export const ownedElsewhere =
	(ctx: CommandContext) =>
	(platform: string, id: string): boolean =>
		platform === "ios" && simMarkerBlock(ctx, id) !== undefined;
