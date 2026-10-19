import { err, ok } from "@delacour/warden-types/result";
import type { WarmConnect } from "../batch/warm-drivers";
import type { CommandContext } from "../context";

/**
 * The warm step's default `connect`: start (or attach to) the device's socket helper with
 * `ensureHelper`, open the iOS driver on the client that proved it was up (one connect, one handshake)
 * and hand back one `snapshot` plus a `close` that only disconnects — the helper itself stays resident
 * for the jobs (`WARDEN_SIMD_SOCKET`) and after the run, until its idle timeout or a `--shutdown` — and a
 * `stop` (`stopHelper`) for a warm-up that failed, so the device's cold jobs do not run their own helpers
 * beside it (20-1). The helper lifecycle and the iOS driver are imported when the first device warms, so
 * `warden batch` / `e2e` start without them.
 */
export function warmConnect(ctx: CommandContext): WarmConnect {
	return async (udid) => {
		const { ensureHelper } = await import("../agent-ui/helper");
		const { openIosDriver } = await import("@delacour/warden-e2e/driver/ios/ios-driver");
		const helper = await ensureHelper(ctx, udid, { keepClient: true });
		if (!helper.success) return err(`${helper.error.message}${helper.error.hint ? ` (${helper.error.hint})` : ""}`);
		const { client, socketPath } = helper.data;
		const driver = await openIosDriver({
			udid,
			exec: ctx.exec,
			socketPath,
			...(client ? { client } : {}),
			now: ctx.now,
		});
		if (!driver.success) {
			await client?.close();
			return err(`${driver.error.code}: ${driver.error.message}`);
		}
		return ok({
			socketPath: helper.data.socketPath,
			snapshot: async () => {
				const shot = await driver.data.snapshot({ interactiveOnly: true });
				return shot.success ? ok(shot.data) : err(`${shot.error.code}: ${shot.error.message}`);
			},
			close: () => driver.data.close(),
			stop: async () => {
				await driver.data.close();
				const { stopHelper } = await import("../agent-ui/helper");
				await stopHelper(ctx, udid, { socketPath });
			},
		});
	};
}

/**
 * Without a warm-up (`--no-warm`, suite `warmDrivers: false`): the socket of a helper `state.json` records as
 * running for `udid` (an earlier `warden ui` or e2e run, within its idle window), so the device's jobs attach
 * to it instead of each spawning a second helper on stdio beside it (20-1). Undefined: none running.
 */
export function residentSocket(host: Pick<CommandContext, "env">): (udid: string) => Promise<string | undefined> {
	return async (udid) => {
		const { helperStatus } = await import("../agent-ui/helper");
		const status = helperStatus(host, udid);
		return status.running && status.socket !== null ? status.socket : undefined;
	};
}
