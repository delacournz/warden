import { openIosDriver } from "@delacour/warden-e2e/driver/ios/ios-driver";
import { err, ok } from "@delacour/warden-types/result";
import { ensureHelper } from "../agent-ui/helper";
import type { WarmConnect } from "../batch/warm-drivers";
import type { CommandContext } from "../context";

/**
 * The warm step's default `connect`: start (or attach to) the device's socket helper with
 * `ensureHelper`, open the iOS driver on that socket and hand back one `snapshot` plus a `close`
 * that only disconnects — the helper itself stays resident for the jobs (`WARDEN_SIMD_SOCKET`)
 * until its idle timeout or `stopHelper` on release.
 */
export function warmConnect(ctx: CommandContext): WarmConnect {
	return async (udid) => {
		const helper = await ensureHelper(ctx, udid);
		if (!helper.success) return err(`${helper.error.message}${helper.error.hint ? ` (${helper.error.hint})` : ""}`);
		const driver = await openIosDriver({ udid, exec: ctx.exec, socketPath: helper.data.socketPath, now: ctx.now });
		if (!driver.success) return err(`${driver.error.code}: ${driver.error.message}`);
		return ok({
			socketPath: helper.data.socketPath,
			snapshot: async () => {
				const shot = await driver.data.snapshot({ interactiveOnly: true });
				return shot.success ? ok(shot.data) : err(`${shot.error.code}: ${shot.error.message}`);
			},
			close: () => driver.data.close(),
		});
	};
}
