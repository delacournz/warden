/** A running log process: `kill` stops it, `exited` settles when it ends on its own or after `kill`. */
export type LogStream = { kill: () => void; exited: Promise<number> };

/** Start `argv` and hand every stdout line to `onLine`. Injected, so tests never spawn. */
export type SpawnLines = (argv: string[], onLine: (line: string) => void) => LogStream;

export type PidFollowOptions = {
	/** the app's current pid, undefined while it is not running */
	resolvePid: () => Promise<number | undefined>;
	/** the command that streams one pid's logs */
	argvFor: (pid: number) => string[];
	spawn: SpawnLines;
	sleep: (ms: number) => Promise<void>;
	onLine: (line: string) => void;
	signal: AbortSignal;
	/** pid re-resolve period; default 2s */
	intervalMs?: number;
	/** called when the followed pid changes (undefined: the app went away) */
	onPid?: (pid: number | undefined) => void;
};

export const PID_FOLLOW_INTERVAL_MS = 2000;

/**
 * `logcat --pid` is bound to one pid, so an app that restarts (crash, relaunch, hot reload of the process) would
 * silence the stream. Re-resolve the pid every `intervalMs` and restart the stream when it changes, or when the
 * stream died while the pid held. Resolves when `signal` aborts, after killing the stream.
 */
export async function followPid(opts: PidFollowOptions): Promise<void> {
	const interval = opts.intervalMs ?? PID_FOLLOW_INTERVAL_MS;
	let current: { pid: number; stream: LogStream; dead: boolean } | undefined;
	let reported: number | undefined;
	const stop = () => {
		current?.stream.kill();
		current = undefined;
	};
	const aborted = new Promise<void>((resolve) => {
		if (opts.signal.aborted) resolve();
		else opts.signal.addEventListener("abort", () => resolve(), { once: true });
	});
	try {
		while (!opts.signal.aborted) {
			const pid = await opts.resolvePid();
			if (current !== undefined && (current.pid !== pid || current.dead)) stop();
			if (current === undefined && pid !== undefined) {
				const stream = opts.spawn(opts.argvFor(pid), opts.onLine);
				const started = { pid, stream, dead: false };
				stream.exited.then(() => {
					started.dead = true;
				});
				current = started;
			}
			if (pid !== reported) {
				reported = pid;
				opts.onPid?.(pid);
			}
			await Promise.race([opts.sleep(interval), aborted]);
		}
	} finally {
		stop();
	}
}
