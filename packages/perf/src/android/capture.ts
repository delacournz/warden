/** Where Perfetto (running as shell) may write on the device. */
export const REMOTE_TRACE_DIR = "/data/misc/perfetto-traces";
/** simpleperf output goes to a place `shell` always owns. */
export const REMOTE_TMP_DIR = "/data/local/tmp";

/** Sampling rate `simpleperf record` is asked for (`-f`), so sample counts convert to CPU time. */
export const SIMPLEPERF_HZ = 4000;

type Adb = { adb: string; serial: string };

export class AndroidCaptureArgv {
	remoteTracePath(ts: number): string {
		return `${REMOTE_TRACE_DIR}/warden-${ts}.pftrace`;
	}

	remoteSimpleperfPath(ts: number): string {
		return `${REMOTE_TMP_DIR}/warden-${ts}.data`;
	}

	private shell({ adb, serial }: Adb, ...args: string[]): string[] {
		return [adb, "-s", serial, "shell", ...args];
	}

	/** Starts Perfetto with the config on stdin. `--background-wait` returns once tracing runs and prints the daemon pid. */
	perfettoStartArgv(a: Adb, remote: string): string[] {
		return this.shell(a, "perfetto", "--txt", "-c", "-", "--background-wait", "-o", remote);
	}

	/** The pid `perfetto --background-wait` prints (alone on a line), or undefined. */
	parsePerfettoPid(output: string): number | undefined {
		const m = /^\s*(\d+)\s*$/m.exec(output);
		return m?.[1] === undefined ? undefined : Number(m[1]);
	}

	/**
	 * `simpleperf record` sampling one pid, detached (`nohup`) and capped by `--duration`; prints the background pid.
	 * Runs through the device shell, so the line is one `sh -c` string.
	 */
	simpleperfStartArgv(a: Adb, pid: number, remote: string, maxDurationMs: number): string[] {
		const seconds = Math.max(1, Math.ceil(maxDurationMs / 1000));
		return this.shell(
			a,
			`nohup simpleperf record -e cpu-clock:u -f ${SIMPLEPERF_HZ} -p ${pid} --duration ${seconds} -o ${remote} >/dev/null 2>&1 & echo $!`
		);
	}

	killArgv(a: Adb, pid: number, signal: "INT" | "TERM" | "KILL"): string[] {
		return this.shell(a, "kill", `-${signal}`, String(pid));
	}

	/** Exit 0 while `/proc/<pid>` exists. */
	aliveArgv(a: Adb, pid: number): string[] {
		return this.shell(a, "test", "-d", `/proc/${pid}`);
	}

	pullArgv({ adb, serial }: Adb, remote: string, local: string): string[] {
		return [adb, "-s", serial, "pull", remote, local];
	}

	removeArgv(a: Adb, remote: string): string[] {
		return this.shell(a, "rm", "-f", remote);
	}

	simpleperfReportArgv(a: Adb, remote: string): string[] {
		return this.shell(a, "simpleperf", "report", "-i", remote, "--stdio", "--sort", "comm,dso,symbol");
	}
}

export const androidCaptureArgv = new AndroidCaptureArgv();
