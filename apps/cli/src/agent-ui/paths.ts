import { join } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import type { CommandContext } from "../context";

/** `$WARDEN_HOME/ui`: one dir per device, holding what `warden ui` remembers between invocations. */
export function uiRoot(ctx: Pick<CommandContext, "env">): string {
	return join(wardenHome(ctx.env), "ui");
}

/** `$WARDEN_HOME/ui/<udid>`: everything `warden ui` remembers about one device between invocations. */
export function uiDir(ctx: Pick<CommandContext, "env">, udid: string): string {
	return join(uiRoot(ctx), udid);
}

/** `$WARDEN_HOME/simd`: the resident `warden-simd` helpers' sockets and logs. */
export function simdDir(host: Pick<CommandContext, "env">): string {
	return join(wardenHome(host.env), "simd");
}
