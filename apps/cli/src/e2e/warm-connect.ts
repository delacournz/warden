import { isPhysicalIosId } from "@delacour/warden-core/types";
import { err, ok } from "@delacour/warden-types/result";
import type { UiError } from "../agent-ui/output";
import type { WarmConnect } from "../batch/warm-drivers";
import type { CommandContext } from "../context";
import { runnerSourcesFor } from "../ios-runner/sim-sources";

/** A runner host's start-up failure as the warm step's error text: `<code>: <message> (<hint>)`, the code `warmGate` stops the run on. */
export function runnerWarmError(error: UiError): string {
	return `${error.code}: ${error.message}${error.hint ? ` (${error.hint})` : ""}`;
}

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
		if (isPhysicalIosId(udid)) return warmRunner(ctx, udid);
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
			runnerSources: runnerSourcesFor(),
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
				const { warning } = await stopHelper(ctx, udid, { socketPath });
				if (warning !== undefined) ctx.err(`warden: ${warning}`);
			},
		});
	};
}

/**
 * The warm step for a physical iPhone: start (or attach to) its resident runner host (`ensureIosRunner`: signs and
 * builds the runner on a cache miss, so this is the slow first call), open the device driver on the client that proved
 * it was up and take one snapshot. The jobs reach the host at `WARDEN_IOS_RUNNER_SOCKET`; closing only disconnects, and
 * the host exits by its own idle timeout. `stop` ends a host whose device will run cold.
 */
async function warmRunner(ctx: CommandContext, udid: string): ReturnType<WarmConnect> {
	const { ensureIosRunner, stopIosRunner } = await import("../agent-ui/helper");
	const { openIosDeviceDriver } = await import("@delacour/warden-e2e/driver/ios/device/device-driver");
	const host = await ensureIosRunner(ctx, udid, { keepClient: true });
	if (!host.success) return err(runnerWarmError(host.error));
	const { client, socketPath } = host.data;
	const driver = await openIosDeviceDriver({
		udid,
		exec: ctx.exec,
		socketPath,
		...(client ? { client } : {}),
		now: ctx.now,
	});
	if (!driver.success) {
		await client?.close();
		const { driverUiError } = await import("../agent-ui/driver");
		return err(runnerWarmError(driverUiError(driver.error)));
	}
	return ok({
		socketPath,
		snapshot: async () => {
			const shot = await driver.data.snapshot({ interactiveOnly: true });
			return shot.success ? ok(shot.data) : err(`${shot.error.code}: ${shot.error.message}`);
		},
		close: () => driver.data.close(),
		stop: async () => {
			await driver.data.close();
			const { warning } = await stopIosRunner(ctx, udid, { socketPath });
			if (warning !== undefined) ctx.err(`warden: ${warning}`);
		},
	});
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
