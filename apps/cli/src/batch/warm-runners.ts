import { dirname, join } from "node:path";

/** One agent-device iOS runner to start: on `udid`, in the daemon at `stateDir`, under `session`. */
export type WarmTarget = { worker: number; udid: string; session: string; stateDir: string };

/** One warm-up's outcome; a failed or timed-out one only means the runner starts it, as without warming. */
export type WarmOutcome = {
	worker: number;
	udid: string;
	ok: boolean;
	/** 127 = it could not be spawned */
	exitCode: number;
	timedOut: boolean;
	log: string;
};

type Proc = { exited: Promise<number>; kill: (signal: "SIGKILL") => void };

export type WarmRun = {
	targets: readonly WarmTarget[];
	/** the project's `agent-device` bin (the runner's own version, so they share one daemon) */
	bin: string;
	env: Record<string, string | undefined>;
	cwd: string;
	logDir: string;
	timeoutMs: number;
	spawn: (
		argv: string[],
		opts: { env: Record<string, string | undefined>; log: string; cwd: string; warm: true }
	) => Proc;
	/** run `fn` once after `ms`; returns cancel */
	after: (ms: number, fn: () => void) => () => void;
	/** tracked so SIGINT can stop a running warm-up */
	track?: (proc: Proc) => () => void;
};

/** The agent-device state dir (= daemon) of a worker's jobs: the env's, else its own under the batch. */
export const agentDeviceStateDir = (
	env: Record<string, string | undefined>,
	batchDir: string,
	worker: number
): string => env.AGENT_DEVICE_STATE_DIR ?? join(batchDir, "agent-device", String(worker));

/** The agent-device session prefix a runner gets (`WARDEN_AGENT_SESSION`); the engine appends `-<slot>`. */
export const agentSession = (firstUdid: string): string => `warden-${firstUdid}`;

/**
 * What to warm for one pool's live devices, matching what its jobs will resume: `single` = one runner
 * (the first device's worker) drives every device, slot = pool order; otherwise each device's own
 * worker drives it alone, as slot 0.
 */
export function warmTargets(
	live: ReadonlyArray<{ worker: number; udid: string }>,
	o: { single: boolean; env: Record<string, string | undefined>; batchDir: string }
): WarmTarget[] {
	const [first] = live;
	if (!first) return [];
	return live.map((d, slot) => {
		const owner = o.single ? first : d;
		return {
			worker: d.worker,
			udid: d.udid,
			session: `${agentSession(owner.udid)}-${o.single ? slot : 0}`,
			stateDir: agentDeviceStateDir(o.env, o.batchDir, owner.worker),
		};
	});
}

/** The nearest `node_modules/.bin/agent-device` from `cwd` up; `undefined` when the project has none. */
export function findAgentDeviceBin(cwd: string, exists: (path: string) => boolean): string | undefined {
	for (let dir = cwd; ; dir = dirname(dir)) {
		const bin = join(dir, "node_modules", ".bin", "agent-device");
		if (exists(bin)) return bin;
		if (dirname(dir) === dir) return undefined;
	}
}

/**
 * Start every target's iOS automation runner at once (`agent-device prepare ios-runner`), so the
 * runner's engine, which warms its devices one after another, finds them up. Never throws.
 */
export function warmRunners(run: WarmRun): Promise<WarmOutcome[]> {
	return Promise.all(
		run.targets.map(async (t): Promise<WarmOutcome> => {
			const log = join(run.logDir, `warm-${t.worker}.log`);
			const base = { worker: t.worker, udid: t.udid, log };
			const argv = [run.bin, "prepare", "ios-runner", "--platform", "ios", "--udid", t.udid, "--session", t.session];
			let proc: Proc;
			try {
				const env = { ...run.env, AGENT_DEVICE_STATE_DIR: t.stateDir, WARDEN_UDID: t.udid };
				proc = run.spawn(argv, { env, log, cwd: run.cwd, warm: true });
			} catch {
				return { ...base, ok: false, exitCode: 127, timedOut: false };
			}
			const untrack = run.track?.(proc);
			let timedOut = false;
			const cancel = run.after(run.timeoutMs, () => {
				timedOut = true;
				proc.kill("SIGKILL");
			});
			try {
				const exitCode = await proc.exited;
				return { ...base, ok: exitCode === 0 && !timedOut, exitCode, timedOut };
			} finally {
				cancel();
				untrack?.();
			}
		})
	);
}
