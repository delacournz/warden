import { join } from "node:path";
import type { BatchWorker } from "@delacour/warden-core/batch/schedule";
import type { SlimProfile } from "@delacour/warden-core/sims/slim.profile";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";

/** What `warden e2e` runs on each leased device before its first spec. */
export type DeviceSetupSpec = {
	/** `sh -c`, `{udid}` substituted */
	command?: string;
	/** iOS: switch off the simulator daemons specs never need, before `command`; a profile keeps categories / labels running */
	slim?: boolean | SlimProfile;
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
	/** `slim`: the jobs switched off, or why it failed (a failed slim only warns) */
	slim?: { jobs: number } | { error: string };
	/** why a device that passed its setup was still dropped before its first job (it cannot reach Metro, 12-7) */
	error?: string;
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
	/** `spec.slim`: slim one device (with `spec.slim`'s profile when it is one) */
	slim?: (udid: string, profile?: SlimProfile) => AsyncResult<string[]>;
	/** tracked so SIGINT can stop a running setup */
	track?: (proc: Proc) => () => void;
};

/** Slim one device when asked; never throws (a device that can't be slimmed still runs specs). */
async function slimDevice(run: SetupRun, udid: string): Promise<DeviceSetup["slim"]> {
	if (!run.spec.slim || !run.slim) return undefined;
	try {
		const res = await run.slim(udid, typeof run.spec.slim === "object" ? run.spec.slim : undefined);
		return res.success ? { jobs: res.data.length } : { error: res.error };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Per device, in parallel: slim (if asked), then run `spec.command`. A spawn failure or non-zero
 * exit marks that device not ok; a failed slim only shows up in the outcome.
 */
export async function setupDevices(run: SetupRun): Promise<DeviceSetup[]> {
	const { command } = run.spec;
	return Promise.all(
		run.devices.map(async (device): Promise<DeviceSetup> => {
			const slim = await slimDevice(run, device.udid);
			const base = { worker: device.worker, udid: device.udid, ...(slim ? { slim } : {}) };
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

/** The slim of each device started the moment it is leased, alongside its app install and warm-up (12-4). */
export type EarlySlim<C extends { device: { id: string } }> = {
	/** `LeaseArgs.onLeased`: start slimming these devices (`skip`ped ones resolve to no jobs touched, unprobed) */
	leased: (outcome: { claimed: readonly C[] }) => void;
	/** `SetupRun.slim`: a leased device's slim already under way, else a fresh one */
	slim: (udid: string) => AsyncResult<string[]>;
	/** every slim started, settled (never rejects) */
	settled: () => Promise<void>;
};

/** Start each leased device's slim at once; `skip(claimed)` says the device is slimmed already, so it is not even probed. */
export function startEarlySlim<C extends { device: { id: string } }>(deps: {
	slim: (udid: string) => AsyncResult<string[]>;
	skip: (claimed: C) => boolean;
}): EarlySlim<C> {
	const started = new Map<string, Promise<Awaited<ReturnType<typeof deps.slim>>>>();
	const run = (udid: string) =>
		deps.slim(udid).catch((error: unknown) => err(error instanceof Error ? error.message : String(error)));
	return {
		leased: (outcome) => {
			for (const c of outcome.claimed) {
				const udid = c.device.id;
				if (!started.has(udid)) started.set(udid, deps.skip(c) ? Promise.resolve(ok([])) : run(udid));
			}
		},
		slim: (udid) => started.get(udid) ?? run(udid),
		settled: async () => {
			await Promise.all(started.values());
		},
	};
}
