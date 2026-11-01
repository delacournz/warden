import { existsSync } from "node:fs";
import { E2eError } from "@delacour/warden-driver/e2e-error";
import { type Exec, execErrors } from "@delacour/warden-runtime/exec";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { type SimdClients, simdClients } from "./simd-client";

/**
 * Recovering a sim whose HID digitizer connection was invalidated (`E_HID`: "The dtuhidd connection … has been
 * invalidated"). Seen on Xcode 27.1 when Device Hub, which had the sim open, quit: the sim stays Booted but every tap
 * is discarded until it reboots.
 */

const SHUTDOWN_MS = 60_000;
const BOOT_MS = 120_000;
/** `simctl shutdown` on a sim that is already shut down: exit 164, or 149 with this text (Xcode 27.1). */
const ALREADY_SHUTDOWN_EXIT = 164;
const ALREADY_SHUTDOWN_TEXT = "current state: Shutdown";

const AFTER_REBOOT_MS = 30_000;

export type HidRecoveryDeps = {
	exec: Exec;
	log?: (line: string) => void;
	/** attach to the resident helper's socket (default {@link SimdClients.connect}) */
	connect?: SimdClients["connect"];
	/** whether the socket file is still there (default: `existsSync`) */
	socketExists?: (path: string) => boolean;
	sleep?: (ms: number) => Promise<void>;
};

const STOP_WAIT_MS = 2_000;
const STOP_POLL_MS = 50;
const SHUTDOWN_REQUEST_MS = 500;
const RUNNER_RESTART_MS = 180_000;

/** Detects and recovers lost HID connections and runner hosts. Use the shared {@link hidRecovery} singleton. */
export class HidRecovery {
	/**
	 * Stops the resident `warden-simd` daemon on `socketPath` (the warm one `warden e2e` started): it is bound to the
	 * boot that just ended, and the reopened driver would otherwise attach to it and hit `E_HID` again. Asks it to
	 * `shutdown` and waits for the socket to go; with no daemon there (a stdio helper dies with its driver) nothing
	 * is done. The next driver open spawns a helper on the new boot.
	 */
	async stopResidentHelper(deps: HidRecoveryDeps, socketPath: string): AsyncResult<"stopped" | "none"> {
		const connect = deps.connect ?? ((options) => simdClients.connect(options));
		const exists = deps.socketExists ?? existsSync;
		const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
		const attached = await connect({ socketPath });
		if (!attached.success) return resultFactory.ok("none");
		await attached.data.request("shutdown", {}, { timeoutMs: SHUTDOWN_REQUEST_MS });
		await attached.data.close();
		for (let waited = 0; waited < STOP_WAIT_MS; waited += STOP_POLL_MS) {
			if (!exists(socketPath)) return resultFactory.ok("stopped");
			await sleep(STOP_POLL_MS);
		}
		return exists(socketPath)
			? resultFactory.err(`warden-simd on ${socketPath} did not stop`)
			: resultFactory.ok("stopped");
	}

	/**
	 * The error of a tap/swipe/type on a sim whose HID connection is gone (wrapped as `ACTION_FAILED` or `DRIVER`), or
	 * of a helper that finds the sim shut down: quitting Device Hub normally shuts down every booted sim (DHW-0 V5), and
	 * the next call then fails `E_NOT_BOOTED`.
	 */
	isHidLost(error: unknown): boolean {
		if (!(error instanceof E2eError) || (error.code !== "ACTION_FAILED" && error.code !== "DRIVER")) return false;
		return this.isHidLostMessage(error.message);
	}

	/** {@link HidRecovery.isHidLost} for an error that is only text (an SDK `WardenError` or engine error carrying the driver's message). */
	isHidLostMessage(message: string): boolean {
		const hidInvalidated = /\bE_HID\b/.test(message) && /dtuhidd connection[\s\S]*invalidated/.test(message);
		return hidInvalidated || /\bE_NOT_BOOTED\b/.test(message);
	}

	/**
	 * The error of a call on a physical iPhone whose runner host is gone (the host or the runner exited, or the socket
	 * closed): the driver's `E_HELPER_CRASHED`, however the error was wrapped.
	 */
	isRunnerLost(error: unknown): boolean {
		if (!(error instanceof E2eError) || (error.code !== "ACTION_FAILED" && error.code !== "DRIVER")) return false;
		return /\bE_HELPER_CRASHED\b/.test(error.message);
	}

	/**
	 * Whether a failed attempt is worth one recovery and the test running again: a simulator that lost its HID connection
	 * (reboot), or a physical iPhone that lost its runner host (restart the host; the phone is never rebooted).
	 */
	isRecoverableLoss(error: unknown, deviceKind: "physical" | undefined): boolean {
		return deviceKind === "physical" ? this.isRunnerLost(error) : this.isHidLost(error);
	}

	/**
	 * Restarts a physical iPhone's runner host (`WARDEN_IOS_RUNNER_RESTART`, `{udid}` replaced): stop the host, start a
	 * new one on the same socket and wait until it answers. Never touches the phone itself (no reboot, no `simctl`).
	 */
	async restartRunnerHost(deps: HidRecoveryDeps, argv: readonly string[] | undefined, udid: string): AsyncResult<void> {
		if (argv === undefined || argv.length === 0) return resultFactory.err("WARDEN_IOS_RUNNER_RESTART is not set");
		const cmd = argv.map((arg) => arg.replaceAll("{udid}", udid));
		const res = await deps.exec(cmd, { timeoutMs: RUNNER_RESTART_MS });
		return res.exitCode === 0 ? resultFactory.ok(undefined) : resultFactory.err(execErrors.format(cmd, res));
	}

	/**
	 * Shuts the sim down and boots it again: `bootstatus -b` boots a shut-down sim itself and waits for it, and opens
	 * no Simulator.app window (the same windowless path warden claims use). The caller reconnects the helper and
	 * relaunches the app.
	 */
	async rebootSim(deps: HidRecoveryDeps, udid: string): AsyncResult<void> {
		const down = ["xcrun", "simctl", "shutdown", udid];
		const shutdown = await deps.exec(down, { timeoutMs: SHUTDOWN_MS });
		const already = shutdown.exitCode === ALREADY_SHUTDOWN_EXIT || shutdown.stderr.includes(ALREADY_SHUTDOWN_TEXT);
		if (shutdown.exitCode !== 0 && !already) return resultFactory.err(execErrors.format(down, shutdown));
		const up = ["xcrun", "simctl", "bootstatus", udid, "-b"];
		const boot = await deps.exec(up, { timeoutMs: BOOT_MS });
		return boot.exitCode === 0 ? resultFactory.ok(undefined) : resultFactory.err(execErrors.format(up, boot));
	}

	/**
	 * Runs `WARDEN_AFTER_REBOOT` (`{udid}` replaced) once the sim is back — `warden` uses it to reopen the sim's Device
	 * Hub window and tile again. Best effort: a failure is logged, never raised, and never fails the test.
	 */
	async runAfterReboot(deps: HidRecoveryDeps, argv: readonly string[] | undefined, udid: string): Promise<void> {
		if (argv === undefined || argv.length === 0) return;
		const cmd = argv.map((arg) => arg.replaceAll("{udid}", udid));
		try {
			const out = await deps.exec(cmd, { timeoutMs: AFTER_REBOOT_MS });
			if (out.exitCode !== 0) deps.log?.(`after-reboot hook failed: ${execErrors.format(cmd, out)}`);
		} catch (error) {
			deps.log?.(`after-reboot hook failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

export const hidRecovery = new HidRecovery();
