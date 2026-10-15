import { err } from "@delacour/warden-types/result";
import type { WarmConnect } from "../batch/warm-drivers";
import type { CommandContext } from "../context";

/**
 * The warm step's default `connect`: the socket helper of one device via `connectHelper`
 * (`../agent-ui/helper`).
 *
 * TODO(A2): `agent-ui/helper.ts` has not landed. Once it exports
 * `connectHelper(ctx, udid, opts) → Result<{ driver, socketPath, pid? }>`, return
 * `{ socketPath, snapshot: () => driver.snapshot(), close: () => driver.close() }` here. Until then
 * every device stays cold (the warm step only warns), so runs still work.
 */
export function warmConnect(_ctx: CommandContext): WarmConnect {
	return async () => err("socket helper not available yet (agent-ui/helper)");
}
