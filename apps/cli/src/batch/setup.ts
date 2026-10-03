import { join } from "node:path";
import type { BatchWorker } from "@delacour/warden-core/batch/schedule";

/** What `warden e2e` runs on each leased device before its first flow. */
export type DeviceSetupSpec = {
	/** `sh -c`, `{udid}` substituted */
	command?: string;
};

/** One device's setup outcome (`e2e-report.json` → `setup`). */
export type DeviceSetup = {
	worker: number;
	udid: string;
	ok: boolean;
	/** the command's exit code (127 = it could not be spawned); absent when there was no command to run */
	exitCode?: number;
	/** the command's stdout + stderr */
	log?: string;
};

type Proc = { exited: Promise<number> };

export type SetupRun = {
	devices: readonly BatchWorker[];
	spec: DeviceSetupSpec;
	env: Record<string, string | undefined>;
	cwd: string;
	logDir: string;
	spawn: (
		cmd: string[],
		opts: { env: Record<string, string | undefined>; log: string; cwd: string; setup: true }
	) => Proc;
	/** tracked so SIGINT can stop a running setup */
	track?: (proc: Proc) => () => void;
};

/** Run `spec.command` once per device, in parallel; a spawn failure or non-zero exit marks that device not ok. */
export async function setupDevices(run: SetupRun): Promise<DeviceSetup[]> {
	const { command } = run.spec;
	return Promise.all(
		run.devices.map(async (device): Promise<DeviceSetup> => {
			const base = { worker: device.worker, udid: device.udid };
			if (command === undefined) return { ...base, ok: true };
			const log = join(run.logDir, `setup-${device.worker}.log`);
			let proc: Proc;
			try {
				proc = run.spawn(["sh", "-c", command.replaceAll("{udid}", device.udid)], {
					env: { ...run.env, WARDEN_UDID: device.udid, WARDEN_WORKER: String(device.worker) },
					log,
					cwd: run.cwd,
					setup: true,
				});
			} catch {
				return { ...base, ok: false, exitCode: 127, log };
			}
			const untrack = run.track?.(proc);
			try {
				const exitCode = await proc.exited;
				return { ...base, ok: exitCode === 0, exitCode, log };
			} finally {
				untrack?.();
			}
		})
	);
}
